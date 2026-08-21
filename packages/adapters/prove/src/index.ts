import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect, Either, Schema as S } from "effect";
import type { GitState, ProveCommand, ProveOutcome, ProvePort, SuiteOutcome } from "@verit/ports";
import { StoreError } from "@verit/ports";

/*
 * THREAT MODEL: this file starts real processes on the machine running it.
 *
 *  - argv only. Every child is `spawn(cmd, args, { shell: false })`. Nothing
 *    read out of a repo, a PR, or a model is ever concatenated into a shell
 *    string, so a script named `test; rm -rf ~` stays one argv element.
 *  - The binary comes from a fixed table (pnpm/npm/yarn/bun/cargo/pytest)
 *    keyed on which manifest and lockfile exist. Repo files decide *whether* a
 *    known runner applies, never *what* binary runs. The one free-form source
 *    is VERIT_PROVE_CMD, which is operator config on this same machine.
 *  - `run` refuses unless the checkout at `cwd` is the repo the caller named,
 *    so reviewing a stranger's fork can never run their tests in your tree.
 *    Fail closed: no remote, no match, no run.
 *  - `run` refuses a second way. Given a `baseline` git snapshot from before
 *    the analysis stage, it re-reads the tree and will not run if HEAD moved
 *    or the snapshot hash moved. That is a secondary guard. Suites then run
 *    in a fresh tree of every committed blob at the baseline HEAD (filters
 *    off, export-ignore included) plus a clean toolchain install, not in
 *    the lane-touched tree. Smudge filters, shadowed bins, and ignored
 *    package rewrites in the source cwd cannot be what executes.
 *  - A clean-tree suite that never collected tests is refused, not failed.
 *    installCleanToolchain throw, a missing interpreter, missing deps, and
 *    pytest collection failure (exit 2, ModuleNotFoundError, no tests
 *    collected) stay inconclusive. A suite that collected and ran tests
 *    still maps exit 0 to success and a real assertion failure to failure.
 *  - When no baseline is given, suites still run in `cwd`.
 *  - Hard timeout, killed as a process group so runners cannot outlive it, and
 *    output is capped so a chatty suite cannot exhaust memory.
 *  - Locally the child env is an allowlist (see proveChildEnv), so keys and
 *    tokens in the operator's shell never leak into a repo's test scripts. On
 *    GitHub Actions the runner is the boundary and the env passes through.
 *
 * This is not a sandbox. With a baseline, the command runs against a fresh
 * checkout of that HEAD, not the working tree the lane could have edited.
 * In CI the GitHub runner is the isolation boundary.
 */

const exec = promisify(execFile);

/* Keep the reason in the message: "prove refused" with no cause is unusable
   both in CI logs and in the workspace, which shows this text verbatim. */
const fail = (label: string) => (e: unknown) =>
  new StoreError(`${label}: ${e instanceof Error ? e.message : String(e)}`, e);

const TAIL_LINES = 100;
const CAPTURE_CHARS = 256_000;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Only the shape we read; a malformed manifest degrades to "no command". */
const PackageJson = S.Struct({
  scripts: S.optional(S.Record({ key: S.String, value: S.Unknown })),
});
const decodePackageJson = S.decodeUnknownEither(PackageJson);

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
};

/** Lockfile decides the runner; the default stays npm, which every JS repo has. */
const packageManager = (cwd: string): string => {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
};

/**
 * Operator override: `VERIT_PROVE_CMD`, one command, argv.
 *
 * Two forms. A JSON array is parsed as exact argv, so an argument with spaces
 * survives: `VERIT_PROVE_CMD='["pnpm","test","--","my case"]'`. Any other
 * value is split on whitespace, which is the old behavior and mangles quoted
 * arguments: `pnpm test "my case"` splits into four tokens, `"my` and `case"`
 * among them. Use the array form when an argument contains a space.
 */
const fromEnv = (): ProveCommand | null => {
  const raw = process.env.VERIT_PROVE_CMD?.trim();
  if (!raw) return null;
  let parts: string[];
  if (raw.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) return null;
      parts = arr as string[];
    } catch {
      // malformed array: refuse rather than fall back to a mangling split
      return null;
    }
  } else {
    parts = raw.split(/\s+/);
  }
  const [command, ...args] = parts;
  if (!command) return null;
  return { command, args, source: "VERIT_PROVE_CMD" };
};

/** Test script text from a package.json-shaped manifest, or null. */
const readManifestTestScript = async (path: string): Promise<string | null> => {
  const raw = await readJson(path);
  if (raw === null) return null;
  const decoded = decodePackageJson(raw);
  if (Either.isLeft(decoded)) return null;
  const t = decoded.right.scripts?.["test"];
  return typeof t === "string" && t.trim() !== "" ? t : null;
};

/** A test script present and non-empty in a package.json-shaped manifest. */
const testScript = async (path: string): Promise<boolean> =>
  (await readManifestTestScript(path)) != null;

/** True when the Makefile declares a `test` target. */
const makefileHasTestTarget = async (cwd: string): Promise<boolean> => {
  try {
    return /^test[ \t]*:/m.test(await readFile(join(cwd, "Makefile"), "utf8"));
  } catch {
    return false;
  }
};

/** True when a top-level file matches any of the extensions. */
const anyFileWithExt = async (cwd: string, exts: readonly string[]): Promise<boolean> => {
  try {
    return (await readdir(cwd)).some((f) => exts.some((e) => f.endsWith(e)));
  } catch {
    return false;
  }
};

/**
 * Every verification suite the checkout declares, plus a note per manifest
 * probed. A polyglot repo (a Go module beside a Rust crate beside a
 * package.json) yields one suite each. The build fallback is gone: a compile
 * exit code is not a behavior proof, so a package.json with only a `build`
 * script contributes no suite and is reported as probed with no test.
 * `VERIT_PROVE_CMD` overrides everything with one explicit suite.
 */
export const detectProveCommands = async (
  cwd: string,
): Promise<{ suites: ProveCommand[]; probed: string[] }> => {
  const env = fromEnv();
  if (env) return { suites: [env], probed: ["VERIT_PROVE_CMD"] };

  const suites: ProveCommand[] = [];
  const probed: string[] = [];
  const has = (f: string): boolean => existsSync(join(cwd, f));
  /** Push a suite and note the manifest, or note it absent. */
  const probe = (present: boolean, note: string, suite?: ProveCommand): void => {
    probed.push(present ? note : `${note} (absent)`);
    if (present && suite) suites.push(suite);
  };

  if (has("package.json")) {
    const hasTest = await testScript(join(cwd, "package.json"));
    probed.push(hasTest ? "package.json#scripts.test" : "package.json (no test script)");
    if (hasTest) {
      suites.push({ command: packageManager(cwd), args: ["run", "test"], source: "package.json#scripts.test" });
    }
  } else {
    probed.push("package.json (absent)");
  }

  probe(has("Cargo.toml"), "Cargo.toml", { command: "cargo", args: ["test"], source: "Cargo.toml" });
  probe(has("pyproject.toml"), "pyproject.toml", { command: "pytest", args: ["-q"], source: "pyproject.toml" });
  probe(has("go.mod"), "go.mod", { command: "go", args: ["test", "./..."], source: "go.mod" });

  if (has("Makefile")) {
    const hasTarget = await makefileHasTestTarget(cwd);
    probed.push(hasTarget ? "Makefile#test" : "Makefile (no test target)");
    if (hasTarget) suites.push({ command: "make", args: ["test"], source: "Makefile" });
  } else {
    probed.push("Makefile (absent)");
  }

  // Java/Kotlin: the wrapper is preferred, then maven, then a bare gradle.
  if (has("gradlew")) {
    probe(true, "gradlew", { command: join(cwd, "gradlew"), args: ["test"], source: "gradlew" });
  } else if (has("pom.xml")) {
    probe(true, "pom.xml", { command: "mvn", args: ["test"], source: "pom.xml" });
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    probe(true, "build.gradle", { command: "gradle", args: ["test"], source: "build.gradle" });
  } else {
    probed.push("gradlew/pom.xml (absent)");
  }

  // Ruby: rspec when the repo is set up for it, else a rake task.
  if (has("Gemfile")) {
    if (has(".rspec") || has("spec")) {
      probed.push("Gemfile+rspec");
      suites.push({ command: "bundle", args: ["exec", "rspec"], source: "Gemfile+rspec" });
    } else if (has("Rakefile")) {
      probed.push("Gemfile+Rakefile");
      suites.push({ command: "bundle", args: ["exec", "rake"], source: "Gemfile+Rakefile" });
    } else {
      probed.push("Gemfile (no rspec or Rakefile)");
    }
  } else {
    probed.push("Gemfile (absent)");
  }

  if (has("composer.json")) {
    const hasTest = await testScript(join(cwd, "composer.json"));
    probed.push(hasTest ? "composer.json#scripts.test" : "composer.json (no test script)");
    if (hasTest) suites.push({ command: "composer", args: ["test"], source: "composer.json#scripts.test" });
  } else {
    probed.push("composer.json (absent)");
  }

  const dotnet = await anyFileWithExt(cwd, [".csproj", ".fsproj", ".sln"]);
  probe(dotnet, "*.csproj/*.sln", { command: "dotnet", args: ["test"], source: "csproj" });

  return { suites, probed };
};

/** The first detected suite, for a surface that shows a single command (the
    workspace offer). Multi-suite runs use `detectProveCommands` directly. */
export const detectProveCommand = async (cwd: string): Promise<ProveCommand | null> =>
  (await detectProveCommands(cwd)).suites[0] ?? null;

const GITHUB_REMOTE = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/** `owner/repo` of the checkout, from its origin remote. Null when unknown. */
export const repoSlugAt = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    const m = GITHUB_REMOTE.exec(stdout.trim());
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
};

const GIT_STATUS_BUFFER = 8 * 1024 * 1024;
const PATH_SPLIT = /[\s"'`:;=]+/;

/** Relative path a suite might execute. Rejects flags, abs paths, and `..`. */
const normalizeRel = (token: string): string | null => {
  const s = token.replace(/\\/g, "/").replace(/^\.\//, "");
  if (s === "" || s.startsWith("/") || s.split("/").includes("..") || s.split("/").includes("")) {
    return null;
  }
  if (!s.includes("/")) return null;
  return s;
};

const isIgnored = async (cwd: string, rel: string): Promise<boolean> => {
  try {
    await exec("git", ["-C", cwd, "check-ignore", "-q", "--", rel], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

/** Fold on-disk bytes at `abs` into `h`. Symlink dirs are not walked. */
const addTreeBytes = async (abs: string, rel: string, h: Hash): Promise<void> => {
  const st = await lstat(abs).catch(() => null);
  if (st === null) {
    h.update("missing");
    return;
  }
  if (st.isSymbolicLink() || st.isFile()) {
    try {
      h.update(await readFile(abs));
    } catch {
      h.update("unreadable");
    }
    return;
  }
  if (!st.isDirectory()) return;
  const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const e of entries) {
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    h.update(childRel);
    h.update("\0");
    await addTreeBytes(join(abs, e.name), childRel, h);
    h.update("\0");
  }
};

/** On-disk bytes of every tracked path. `git hash-object` applies clean and
    would miss a smudge rewrite; readFile does not. */
const addTrackedWorkingBytes = async (cwd: string, h: Hash): Promise<void> => {
  const listed = await exec("git", ["-C", cwd, "ls-files", "-z"], {
    timeout: 30_000,
    maxBuffer: GIT_STATUS_BUFFER,
  });
  const paths = listed.stdout.split("\0").filter(Boolean).sort();
  for (const rel of paths) {
    h.update(rel);
    h.update("\0");
    try {
      h.update(await readFile(join(cwd, rel)));
    } catch {
      h.update("missing");
    }
    h.update("\0");
  }
};

/** Directory npm, pnpm, yarn, and bun prepend to PATH for `run test`.
    Bare names (`vitest`, a shadowed `node`) resolve here, not from the
    script text. Tokenizing scripts.test never names this path. */
const JS_PACKAGE_MANAGER_BIN = "node_modules/.bin";

/** Gitignored roots a detected suite can execute: path tokens from
    package.json / composer.json test scripts and from VERIT_PROVE_CMD,
    plus the package-manager bin dir when a JS suite is detected.
    A file token hashes its ignored parent directory when that parent is
    ignored, so a write anywhere in that toolchain dir moves the snapshot. */
const addExecutableIgnoredBytes = async (cwd: string, h: Hash): Promise<void> => {
  const tokens: string[] = [];
  const take = (raw: string): void => {
    const n = normalizeRel(raw);
    if (n) tokens.push(n);
  };
  const jsTest = await readManifestTestScript(join(cwd, "package.json"));
  if (jsTest != null) {
    for (const part of jsTest.split(PATH_SPLIT)) take(part);
  }
  const composerTest = await readManifestTestScript(join(cwd, "composer.json"));
  if (composerTest != null) {
    for (const part of composerTest.split(PATH_SPLIT)) take(part);
  }
  const env = fromEnv();
  if (env) {
    take(env.command);
    for (const arg of env.args) take(arg);
  }
  const roots = new Set<string>();
  for (const rel of tokens) {
    const slash = rel.lastIndexOf("/");
    const parent = slash === -1 ? "" : rel.slice(0, slash);
    if (parent !== "" && (await isIgnored(cwd, parent))) roots.add(parent);
    else if (await isIgnored(cwd, rel)) roots.add(rel);
  }
  // The JS suite is always `npm/pnpm/yarn/bun run test`. That runner
  // resolves bare script names from node_modules/.bin, which is gitignored.
  // Hash it whenever a package.json test script exists, not when a token
  // happens to mention it.
  if (jsTest != null) roots.add(JS_PACKAGE_MANAGER_BIN);
  for (const root of [...roots].sort()) {
    h.update("ignored:");
    h.update(root);
    h.update("\0");
    await addTreeBytes(join(cwd, root), "", h);
    h.update("\0");
  }
};

/**
 * A snapshot of the working tree at `cwd`. Null when `cwd` is not a git
 * checkout. The caller records one before an analysis stage runs and hands
 * it back to `run`, which compares against a fresh read to see whether the
 * bytes prove will execute moved in between.
 *
 * Porcelain and ls-files -v are git metadata. A clean/smudge filter can
 * change the working-tree bytes without flipping either, and an ignored
 * toolchain directory never appears in either. For a JS suite the package
 * manager resolves bare names from node_modules/.bin, which is also
 * ignored. Folding those on-disk bytes in means the snapshot moves when
 * the suite's inputs move.
 */
export const gitState = async (cwd: string): Promise<GitState | null> => {
  try {
    const head = await exec("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10_000 });
    const status = await exec("git", ["-C", cwd, "status", "--porcelain"], {
      timeout: 30_000,
      maxBuffer: GIT_STATUS_BUFFER,
    });
    // git status omits a tracked file once it is marked skip-worktree or
    // assume-unchanged, so an escaped lane can doctor a file on disk and leave
    // porcelain empty with HEAD unmoved. ls-files -v prints the index bit of
    // every path (S skip-worktree, lowercase assume-unchanged, H otherwise);
    // folding it into the hash means setting either bit moves the snapshot, and
    // the bit cannot be cleared without re-exposing the edit in porcelain.
    const flags = await exec("git", ["-C", cwd, "ls-files", "-v"], {
      timeout: 30_000,
      maxBuffer: GIT_STATUS_BUFFER,
    });
    const hasher = createHash("sha256");
    hasher.update(status.stdout);
    hasher.update("\0");
    hasher.update(flags.stdout);
    hasher.update("\0");
    await addTrackedWorkingBytes(cwd, hasher);
    hasher.update("\0");
    await addExecutableIgnoredBytes(cwd, hasher);
    return {
      headSha: head.stdout.trim(),
      porcelainHash: hasher.digest("hex"),
      clean: status.stdout.trim() === "",
    };
  } catch {
    return null;
  }
};

/* Exact env keys a local test run may inherit. Everything else, and every
   credential in particular, must be named in VERIT_PROVE_ENV to pass. */
const ENV_ALLOWLIST = new Set([
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

const ENV_ALLOWED_PREFIXES = ["npm_config_"];

/**
 * The environment the untrusted verification command runs with.
 *
 * Locally this is an allowlist: PATH, HOME, toolchain vars, npm_config_*, and
 * whatever the operator names in VERIT_PROVE_ENV (comma-separated keys). API
 * keys and tokens sitting in the operator's shell (ANTHROPIC_API_KEY,
 * GITHUB_TOKEN, ...) never reach a repo's test scripts implicitly.
 *
 * On GitHub Actions the runner is the isolation boundary and workflows rely on
 * job-level env, so the full environment passes through unchanged there.
 */
export const proveChildEnv = (
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const forced = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  if (base.GITHUB_ACTIONS === "true") {
    return { ...base, ...forced };
  }
  const declared = new Set(
    (base.VERIT_PROVE_ENV ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  // Scrub by deletion so the augmented ProcessEnv shape (e.g. Next's required
  // NODE_ENV) stays satisfied without a cast.
  const child = { ...base };
  for (const key of Object.keys(child)) {
    const allowed =
      ENV_ALLOWLIST.has(key) ||
      declared.has(key) ||
      ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p));
    if (!allowed) delete child[key];
  }
  return { ...child, ...forced };
};

const tail = (text: string): string => {
  const lines = text.split("\n");
  return lines.slice(-TAIL_LINES).join("\n").trimEnd();
};

const shellDisplay = (c: ProveCommand): string => [c.command, ...c.args].join(" ");

interface RawRun {
  exitCode: number;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

const spawnCaptured = (cmd: ProveCommand, cwd: string, timeoutMs: number): Promise<RawRun> =>
  new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = spawn(cmd.command, [...cmd.args], {
      cwd,
      shell: false,
      // own process group, so the timeout kills the whole runner tree
      detached: process.platform !== "win32",
      env: proveChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    const absorb = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > CAPTURE_CHARS) output = output.slice(-CAPTURE_CHARS);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    const stop = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        // a signalled death is a failure, and must never read as exit 0
        exitCode: code ?? (signal ? 137 : 1),
        timedOut,
        output,
        durationMs: Date.now() - started,
      });
    });
  });

/** One suite's outcome, plus its full captured log for the combined blob. */
interface RanSuite extends SuiteOutcome {
  readonly fullLog: string;
}

/**
 * Run one suite and report it. A spawn that never starts (a missing runner
 * binary raises ENOENT) is `skipped`, not failed: the suite did not run, so it
 * is not the repo's test result. The combined conclusion states it and stays
 * off green, but a missing toolchain is never dressed up as a failing suite.
 */
const runOneSuite = async (
  cmd: ProveCommand,
  cwd: string,
  timeoutMs: number,
): Promise<RanSuite> => {
  const command = shellDisplay(cmd);
  try {
    const raw = await spawnCaptured(cmd, cwd, timeoutMs);
    return {
      command,
      source: cmd.source,
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      timedOut: raw.timedOut,
      logTail: tail(raw.output),
      fullLog: raw.output.trimEnd(),
    };
  } catch (e) {
    return {
      command,
      source: cmd.source,
      exitCode: 127,
      durationMs: 0,
      timedOut: false,
      logTail: "",
      fullLog: "",
      skipped: e instanceof Error ? e.message : String(e),
    };
  }
};

/**
 * A clean-tree result that never ran tests is inconclusive. Never paint that
 * red: source CI can be green while the fresh tree lacks deps or an
 * interpreter. A suite that collected and then failed assertions is left
 * alone. Do not map every non-zero exit here.
 */
const cleanTreeSuiteRefusal = (s: RanSuite): string | undefined => {
  if (s.skipped != null) {
    return `the clean prove tree could not start ${s.command}: ${s.skipped}`;
  }
  if (s.timedOut || s.exitCode === 0) return undefined;
  const log = `${s.fullLog}\n${s.logTail}`;
  const pytest = s.command.startsWith("pytest") || s.source === "pyproject.toml";
  const missingModule = /ModuleNotFoundError|ImportError|No module named /i.test(log);
  const noCollected = /no tests (were )?collected/i.test(log);
  const collectionError = /ERROR collecting|errors during collection/i.test(log);
  if (missingModule || noCollected || collectionError || (pytest && s.exitCode === 2)) {
    return `the clean prove tree could not collect tests for ${s.command}: missing interpreter, missing dependencies, or collection failure (exit ${s.exitCode}).`;
  }
  return undefined;
};

const cleanTreeRefusal = (ran: readonly RanSuite[]): string | undefined => {
  for (const s of ran) {
    const reason = cleanTreeSuiteRefusal(s);
    if (reason != null) return reason;
  }
  return undefined;
};

interface CombineCtx {
  readonly cwd: string;
  readonly repo: string;
  readonly startedAt: string;
  readonly headSha: string | null;
  readonly porcelainClean: boolean;
}

/**
 * Fold the per-suite outcomes into one ProveOutcome. A single suite that ran
 * keeps the exact shape every surface rendered before: no `suites`, its own
 * command, exit code and full log. Several suites, or any skipped suite, attach
 * the per-suite breakdown so the Check derives its conclusion from the suites,
 * not from the exit code alone. That matters because a lone suite whose runner
 * is missing must not read as a pass: attaching `suites` makes the Check go
 * neutral instead of green.
 *
 * The combined exit code stays honest for the dashboard, which reads it through
 * proofVerdict: the first real failure, else non-zero when a suite was skipped
 * (never green while a declared suite went unrun), else zero.
 */
const combineSuites = (ran: readonly RanSuite[], ctx: CombineCtx): ProveOutcome => {
  const suites: SuiteOutcome[] = ran.map(({ fullLog: _f, ...s }) => s);
  const failing = ran.find((s) => s.skipped == null && (s.timedOut || s.exitCode !== 0));
  const anySkipped = ran.some((s) => s.skipped != null);
  const single = ran.length === 1;
  // one suite that actually ran renders as before; multi, or any skip, carries
  // the per-suite breakdown so the conclusion is derived from it
  const attachSuites = ran.length > 1 || anySkipped;
  const first = ran[0]!;
  const combinedLog = single
    ? first.fullLog
    : ran
        .map(
          (s) =>
            `$ ${s.command}  (${s.source})\n${s.skipped != null ? `skipped: ${s.skipped}` : `exit ${s.exitCode}`}\n${s.fullLog}`,
        )
        .join("\n\n")
        .slice(-CAPTURE_CHARS);
  return {
    command: single ? first.command : `${ran.length} suites: ${ran.map((s) => s.command).join(", ")}`,
    source: single ? first.source : ran.map((s) => s.source).join(", "),
    cwd: ctx.cwd,
    repo: ctx.repo,
    exitCode: failing ? failing.exitCode || 1 : anySkipped ? 1 : 0,
    durationMs: ran.reduce((n, s) => n + s.durationMs, 0),
    timedOut: ran.some((s) => s.timedOut),
    logTail: single ? first.logTail : tail(combinedLog),
    log: combinedLog,
    startedAt: ctx.startedAt,
    headSha: ctx.headSha,
    porcelainClean: ctx.porcelainClean,
    ...(attachSuites ? { suites } : {}),
  };
};

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const CHECKOUT_TIMEOUT_MS = 60_000;

interface ProveTree {
  readonly root: string;
  readonly cleanup: () => void;
}

const packageJsonHasDeps = (raw: unknown): boolean => {
  if (raw === null || typeof raw !== "object") return false;
  const rec = raw as Record<string, unknown>;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const v = rec[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      return true;
    }
  }
  return false;
};

/** Install JS deps from the lockfile in a fresh tree. Ignore lifecycle
    scripts: those are untrusted repo code. Other languages resolve toolchains
    outside the tree (cargo, go) or are installed later. Skip when the
    manifest names no packages and there is no lockfile: a clean install is
    then a no-op, and we do not wait on a registry. */
const installCleanToolchain = async (root: string): Promise<void> => {
  if (!existsSync(join(root, "package.json"))) return;
  const hasLock =
    existsSync(join(root, "pnpm-lock.yaml")) ||
    existsSync(join(root, "yarn.lock")) ||
    existsSync(join(root, "package-lock.json")) ||
    existsSync(join(root, "bun.lockb")) ||
    existsSync(join(root, "bun.lock"));
  if (!hasLock && !packageJsonHasDeps(await readJson(join(root, "package.json")))) return;
  const pm = packageManager(root);
  const args =
    pm === "pnpm"
      ? ["install", "--frozen-lockfile", "--ignore-scripts"]
      : pm === "yarn"
        ? ["install", "--frozen-lockfile", "--ignore-scripts"]
        : pm === "bun"
          ? ["install", "--frozen-lockfile", "--ignore-scripts"]
          : existsSync(join(root, "package-lock.json"))
            ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
            : ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  await exec(pm, args, {
    cwd: root,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: GIT_STATUS_BUFFER,
    env: proveChildEnv(),
  });
};

/** Every blob at `headSha`, raw object bytes. `ls-tree` names committed
    paths including export-ignore. `cat-file blob` does not smudge and
    does not honor export-ignore. `git archive` does both of those and
    is not used. `--no-replace-objects` so a `git replace` planted from a
    shared worktree cannot swap the blob the suite will read. Mode
    `120000` is a symlink: the blob is the target path, and checkout
    creates a link. writeFile of those bytes would make a regular file.
    Mode `160000` is a gitlink. checkout-index and a GitHub checkout
    make an empty directory. Do not fetch the submodule. */
const writeCommittedTree = async (source: string, headSha: string, root: string): Promise<void> => {
  const listed = spawnSync("git", ["--no-replace-objects", "-C", source, "ls-tree", "-r", "-z", headSha], {
    encoding: "buffer",
    timeout: CHECKOUT_TIMEOUT_MS,
    maxBuffer: GIT_STATUS_BUFFER,
  });
  if (listed.status !== 0) {
    throw new Error(listed.stderr.toString("utf8") || `ls-tree failed for ${headSha}`);
  }
  const entries = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const meta = entry.slice(0, tab);
    const rel = entry.slice(tab + 1);
    const [mode, kind] = meta.split(" ");
    if (rel === "" || rel.split("/").includes("..")) continue;
    const dest = join(root, rel);
    if (mode === "160000") {
      await mkdir(dest, { recursive: true });
      continue;
    }
    if (kind !== "blob") continue;
    await mkdir(dirname(dest), { recursive: true });
    const blob = spawnSync(
      "git",
      ["--no-replace-objects", "-C", source, "cat-file", "blob", `${headSha}:${rel}`],
      {
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: GIT_STATUS_BUFFER,
      },
    );
    if (blob.status !== 0) {
      throw new Error(blob.stderr.toString("utf8") || `cat-file failed for ${rel}`);
    }
    if (mode === "120000") {
      await symlink(blob.stdout.toString("utf8"), dest);
    } else {
      await writeFile(dest, blob.stdout);
    }
  }
};

/**
 * A disposable working tree of every committed blob at `headSha`, then a
 * clean toolchain install. Built from ls-tree + cat-file, not archive,
 * so export-ignore paths and unfiltered blobs are what the suite sees.
 * Gitlink paths are empty directories, as checkout-index would create.
 */
const prepareProveTree = async (source: string, headSha: string): Promise<ProveTree> => {
  const base = await mkdtemp(join(tmpdir(), "verit-prove-"));
  const root = join(base, "tree");
  const wipe = (): void => {
    rmSync(base, { recursive: true, force: true });
  };
  try {
    await mkdir(root);
    await writeCommittedTree(source, headSha, root);
    await installCleanToolchain(root);
    return { root, cleanup: wipe };
  } catch (e) {
    wipe();
    throw e;
  }
};

export const makeProveRunner = (): ProvePort => ({
  detect: (cwd) =>
    Effect.tryPromise({
      try: () => detectProveCommand(resolve(cwd)),
      catch: fail("prove detect"),
    }),

  repoAt: (cwd) =>
    Effect.tryPromise({
      try: () => repoSlugAt(resolve(cwd)),
      catch: fail("prove repoAt"),
    }),

  run: ({ cwd, expectRepo, timeoutMs, baseline }) =>
    Effect.tryPromise({
      try: async (): Promise<ProveOutcome> => {
        const dir = resolve(cwd);
        const local = await repoSlugAt(dir);
        // fail closed: prove only ever runs in the repo the caller pointed at
        if (local === null || local.toLowerCase() !== expectRepo.toLowerCase()) {
          throw new Error(
            `refusing to prove: ${dir} is ${local ?? "not a GitHub checkout"}, expected ${expectRepo}`,
          );
        }
        const { suites: detected, probed } = await detectProveCommands(dir);
        const state = await gitState(dir);
        const startedAt = new Date().toISOString();
        const headSha = state?.headSha ?? null;
        const porcelainClean = state?.clean ?? false;

        // No suite to run. This is inconclusive, never a failure: the Check
        // names the manifests probed so the repo owner knows what to add.
        if (detected.length === 0) {
          return {
            command: "(no test command)",
            source: "detection",
            cwd: dir,
            repo: local,
            exitCode: 1,
            durationMs: 0,
            timedOut: false,
            logTail: "",
            log: "",
            startedAt,
            headSha,
            porcelainClean,
            refused: `no test command found in ${dir}`,
            probed,
          };
        }

        // Read the tree as late as possible, right before the commands run, and
        // refuse if it moved since the analysis stage's snapshot.
        const moved =
          baseline != null &&
          (state === null ||
            state.headSha !== baseline.headSha ||
            state.porcelainHash !== baseline.porcelainHash);
        if (moved) {
          return {
            command: detected.map(shellDisplay).join(" && "),
            source: detected.map((c) => c.source).join(", "),
            cwd: dir,
            repo: local,
            exitCode: 1,
            durationMs: 0,
            timedOut: false,
            logTail: "",
            log: "",
            startedAt,
            headSha,
            porcelainClean,
            refused:
              "the working tree changed during analysis: HEAD or an uncommitted file differs from the snapshot taken before the analysis stage ran. prove will not measure a tree that moved under it, so this check stays neutral.",
          };
        }

        // With a baseline, never execute in the source cwd. A lane can change
        // ignored packages and still leave gitState matching. Materialize
        // every committed blob at the baseline HEAD and install a clean
        // toolchain, then run there.
        let runCwd = dir;
        let cleanup: (() => void) | null = null;
        if (baseline != null) {
          try {
            const prepared = await prepareProveTree(dir, baseline.headSha);
            runCwd = prepared.root;
            cleanup = prepared.cleanup;
          } catch (e) {
            return {
              command: detected.map(shellDisplay).join(" && "),
              source: detected.map((c) => c.source).join(", "),
              cwd: dir,
              repo: local,
              exitCode: 1,
              durationMs: 0,
              timedOut: false,
              logTail: "",
              log: "",
              startedAt,
              headSha,
              porcelainClean,
              refused: `could not prepare a clean prove checkout of ${baseline.headSha}: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        }

        try {
          const ran: RanSuite[] = [];
          for (const cmd of detected) {
            ran.push(await runOneSuite(cmd, runCwd, timeoutMs ?? DEFAULT_TIMEOUT_MS));
          }
          const combined = combineSuites(ran, { cwd: dir, repo: local, startedAt, headSha, porcelainClean });
          // Only the clean tree. A source-cwd run that actually collected
          // tests keeps its exit code. installCleanToolchain throw is already
          // refused above when prepareProveTree fails.
          if (cleanup != null) {
            const reason = cleanTreeRefusal(ran);
            if (reason != null) return { ...combined, refused: reason };
          }
          return combined;
        } finally {
          cleanup?.();
        }
      },
      catch: fail("prove"),
    }),
});
