import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { proveChildEnv } from "@verit/adapter-prove";
import type { LaneTool } from "./client";

/*
 * THREAT MODEL: these tools run with model-chosen arguments on the reviewer's
 * machine.
 *
 *  - read_file / list_dir / grep are confined to the workspace root. Paths are
 *    resolved, realpathed, and rejected when they land outside, so `../` and
 *    symlink escapes read nothing.
 *  - bash is bash. The command string is model output and the mitigation is
 *    the environment, not the parser: children get the SAME allowlist scrub as
 *    prove (proveChildEnv), with the lane's own key vars deleted first, so no
 *    API key ever reaches a tool subprocess. Plus a hard timeout and a capped
 *    buffer.
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

/** Env vars that must never reach a tool subprocess, whatever proveChildEnv passes. */
const LANE_KEY_VARS = ["VERIT_LANE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * The environment for lane tool subprocesses: the prove allowlist scrub, with
 * the lane's key vars deleted before the scrub even runs. proveChildEnv passes
 * the full env through on GitHub Actions; the deletion holds there too, so
 * "never pass API keys into tool subprocesses" has no CI exception.
 */
export const laneChildEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const withoutKeys = { ...base };
  for (const key of LANE_KEY_VARS) delete withoutKeys[key];
  return proveChildEnv(withoutKeys);
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
