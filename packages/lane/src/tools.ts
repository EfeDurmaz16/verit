import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { LaneTool } from "./client";

/*
 * THREAT MODEL: these tools run with model-chosen arguments on the reviewer's
 * machine.
 *
 *  - read_file / list_dir / grep are confined to the workspace root. Paths are
 *    resolved, realpathed, and rejected when they land outside, so `../` and
 *    symlink escapes read nothing.
 *  - bash is bash. The command string is model output and the mitigation is
 *    the environment, not the parser: the child env is an allowlist the lane
 *    builds itself (laneChildEnv). It never starts from the full environment
 *    and never widens on CI, so no token or key ever reaches a tool subprocess
 *    on any platform. Plus a hard timeout and a capped buffer.
 *  - bash runs in an isolated checkout, not the tree prove measures. See
 *    openLaneCheckout in ./checkout: the lane cannot mutate the workspace a
 *    green Check depends on.
 *  - Every result is truncated with an explicit marker, so one chatty command
 *    cannot flood the context window silently.
 */

export const TOOL_RESULT_CHARS = 24_000;
const BASH_TIMEOUT_MS = 120_000;
const SPAWN_BUFFER = 8 * 1024 * 1024;

/** Cap a tool result. The marker is explicit so the model knows it saw a slice. */
export const truncateResult = (s: string, cap: number = TOOL_RESULT_CHARS): string =>
  s.length <= cap
    ? s
    : `${s.slice(0, cap)}\n[verit-lane: truncated, showing first ${cap} of ${s.length} chars]`;

/*
 * Env var names a lane tool subprocess may inherit. Non-secret infrastructure
 * only: the vars a toolchain needs to run git, node, cargo, python. No token,
 * key, or credential is on this list, ever. The lane keeps its own copy rather
 * than reusing the prove adapter's, because the lane's boundary is stricter:
 * prove passes the whole environment through on GitHub Actions where the runner
 * is the isolation boundary, and the lane must never do that. Two boundaries,
 * two lists, so widening one cannot silently widen the other.
 */
const LANE_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "USER",
  "CI",
  "NODE_ENV",
  // language toolchains
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "PNPM_HOME",
  "NVM_DIR",
  "VOLTA_HOME",
  "PYTHONPATH",
  "VIRTUAL_ENV",
]);

const LANE_ENV_ALLOWED_PREFIXES = ["npm_config_"];

const LANE_ENV_FORCED = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };

/**
 * The environment for lane tool subprocesses. Built as an allowlist: the child
 * starts empty and only named-safe vars are copied in, so nothing unlisted can
 * leak by accident, on any platform, CI included. The one escape hatch is
 * VERIT_LANE_ENV, a comma-separated list of extra keys the operator chooses to
 * pass through. API keys and tokens are never on the base list.
 */
export const laneChildEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const declared = new Set(
    (base.VERIT_LANE_ENV ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const allowed =
      LANE_ENV_ALLOWLIST.has(key) ||
      declared.has(key) ||
      LANE_ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p));
    if (allowed) child[key] = value;
  }
  return { ...child, ...LANE_ENV_FORCED };
};

/** Resolve a model-supplied path inside root, or null when it escapes. */
const resolveWithin = (root: string, p: string): string | null => {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
  // Symlinks can point outside even when the literal path stays inside.
  try {
    const real = realpathSync(abs);
    const realRel = relative(realpathSync(root), real);
    if (realRel !== "" && (realRel.startsWith("..") || isAbsolute(realRel))) return null;
    return real;
  } catch {
    // Path does not exist yet; the literal containment check above decided.
    return abs;
  }
};

export interface ToolOutcome {
  readonly content: string;
  readonly isError: boolean;
}

const ok = (content: string): ToolOutcome => ({ content: truncateResult(content), isError: false });
const err = (content: string): ToolOutcome => ({ content: truncateResult(content), isError: true });

const str = (input: unknown, key: string): string | null => {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

export const LANE_TOOLS: readonly LaneTool[] = [
  {
    name: "read_file",
    description:
      "Read one file from the checkout, relative to the workspace root. Output is truncated past a cap.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to the root" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List one directory of the checkout. Defaults to the workspace root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path relative to the root" } },
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with an extended regex (grep -rnE). Skips .git, node_modules, dist. Returns path:line:text matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regex to search for" },
        path: { type: "string", description: "Directory or file to search, relative to the root" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description:
      "Run one bash command in the workspace root. Use for git log, ls, wc and similar read-only inspection. The environment is scrubbed: no API keys or tokens are available. Hard timeout, output truncated.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The bash command line to run" } },
      required: ["command"],
    },
  },
];

/**
 * Execute one lane tool. Never throws: every failure is an isError result the
 * model can read and route around.
 */
export const executeLaneTool = (root: string, name: string, input: unknown): ToolOutcome => {
  try {
    if (name === "read_file") {
      const path = str(input, "path");
      if (path === null) return err("read_file needs {path: string}");
      const abs = resolveWithin(root, path);
      if (abs === null) return err(`path escapes the workspace root: ${path}`);
      return ok(readFileSync(abs, "utf8"));
    }

    if (name === "list_dir") {
      const path = str(input, "path") ?? ".";
      const abs = resolveWithin(root, path);
      if (abs === null) return err(`path escapes the workspace root: ${path}`);
      const entries = readdirSync(abs, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return ok(entries.join("\n") || "(empty directory)");
    }

    if (name === "grep") {
      const pattern = str(input, "pattern");
      if (pattern === null) return err("grep needs {pattern: string}");
      const path = str(input, "path") ?? ".";
      const abs = resolveWithin(root, path);
      if (abs === null) return err(`path escapes the workspace root: ${path}`);
      const r = spawnSync(
        "grep",
        [
          "-rnIE",
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          "--exclude-dir=dist",
          "--exclude-dir=.next",
          pattern,
          abs,
        ],
        { encoding: "utf8", timeout: BASH_TIMEOUT_MS, maxBuffer: SPAWN_BUFFER, env: laneChildEnv() },
      );
      if (r.error) return err(`grep failed: ${r.error.message}`);
      if (r.status === 1) return ok("(no matches)");
      if (r.status !== 0) return err(`grep exited ${r.status}: ${r.stderr ?? ""}`);
      return ok(r.stdout ?? "");
    }

    if (name === "bash") {
      const command = str(input, "command");
      if (command === null) return err("bash needs {command: string}");
      const r = spawnSync("bash", ["-c", command], {
        cwd: root,
        encoding: "utf8",
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: SPAWN_BUFFER,
        env: laneChildEnv(),
      });
      if (r.error) return err(`bash failed: ${r.error.message}`);
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
      if (r.status !== 0) return err(`exit ${r.status}\n${output}`);
      return ok(output || "(no output)");
    }

    return err(`unknown tool: ${name}`);
  } catch (e) {
    return err(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
