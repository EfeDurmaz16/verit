import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { proofVerdict } from "@verit/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectProveCommand,
  detectProveCommands,
  gitState,
  makeProveRunner,
  proveChildEnv,
} from "./index";

const hasBin = (bin: string): boolean =>
  spawnSync(bin, ["version"], { encoding: "utf8" }).status === 0 ||
  spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;

const tmp = () => mkdtemp(join(tmpdir(), "verit-prove-"));

afterEach(() => {
  delete process.env.VERIT_PROVE_CMD;
});

describe("detectProveCommand", () => {
  it("prefers the test script and picks the runner from the lockfile", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(await detectProveCommand(dir)).toEqual({
      command: "pnpm",
      args: ["run", "test"],
      source: "package.json#scripts.test",
    });
  });

  it("never treats a build script as a test suite: a compile is not a proof", async () => {
    const js = await tmp();
    await writeFile(join(js, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    // the build fallback is gone. A build-only package.json yields no suite.
    expect(await detectProveCommand(js)).toBeNull();
    const { suites, probed } = await detectProveCommands(js);
    expect(suites).toHaveLength(0);
    expect(probed).toContain("package.json (no test script)");
  });

  it("detects the manifest runners: cargo, pytest, go", async () => {
    const rust = await tmp();
    await writeFile(join(rust, "Cargo.toml"), "[package]\nname = 'x'\n");
    expect(await detectProveCommand(rust)).toMatchObject({ command: "cargo", args: ["test"] });

    const py = await tmp();
    await writeFile(join(py, "pyproject.toml"), "[project]\nname = 'x'\n");
    expect((await detectProveCommand(py))?.command).toBe("pytest");

    const go = await tmp();
    await writeFile(join(go, "go.mod"), "module example.com/x\n\ngo 1.20\n");
    expect(await detectProveCommand(go)).toEqual({
      command: "go",
      args: ["test", "./..."],
      source: "go.mod",
    });

    expect(await detectProveCommand(await tmp())).toBeNull();
  });

  it("detects Makefile, Gemfile, composer.json and .csproj suites", async () => {
    const mk = await tmp();
    await writeFile(join(mk, "Makefile"), "build:\n\ttsc\ntest:\n\tgo test ./...\n");
    expect(await detectProveCommand(mk)).toEqual({ command: "make", args: ["test"], source: "Makefile" });

    const mkNoTarget = await tmp();
    await writeFile(join(mkNoTarget, "Makefile"), "build:\n\ttsc\n");
    expect((await detectProveCommands(mkNoTarget)).suites).toHaveLength(0);
    expect((await detectProveCommands(mkNoTarget)).probed).toContain("Makefile (no test target)");

    const rb = await tmp();
    await writeFile(join(rb, "Gemfile"), "source 'https://rubygems.org'\n");
    await writeFile(join(rb, ".rspec"), "--require spec_helper\n");
    expect(await detectProveCommand(rb)).toMatchObject({ command: "bundle", args: ["exec", "rspec"] });

    const php = await tmp();
    await writeFile(join(php, "composer.json"), JSON.stringify({ scripts: { test: "phpunit" } }));
    expect(await detectProveCommand(php)).toEqual({
      command: "composer",
      args: ["test"],
      source: "composer.json#scripts.test",
    });

    const cs = await tmp();
    await writeFile(join(cs, "App.csproj"), "<Project></Project>\n");
    expect(await detectProveCommand(cs)).toMatchObject({ command: "dotnet", args: ["test"] });
  });

  it("detects one suite per language in a polyglot (pay-kit-shaped) repo", async () => {
    // python + rust + ts, the shape of a payments SDK. Three suites, one each.
    const dir = await tmp();
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname = 'paykit'\n");
    await writeFile(join(dir, "Cargo.toml"), "[package]\nname = 'paykit'\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const { suites } = await detectProveCommands(dir);
    const sources = suites.map((s) => s.source).sort();
    expect(sources).toEqual(["Cargo.toml", "package.json#scripts.test", "pyproject.toml"]);
  });

  it("names every probed manifest when nothing matches", async () => {
    const { suites, probed } = await detectProveCommands(await tmp());
    expect(suites).toHaveLength(0);
    // the Check needs to say what it looked for
    for (const m of ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Makefile"]) {
      expect(probed.some((p) => p.startsWith(m))).toBe(true);
    }
  });

  it("never lets a script name become a second command", async () => {
    const dir = await tmp();
    // a hostile manifest: the injection attempt must stay inside the *script*,
    // which we never read. We only ever run `npm run test`
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest; rm -rf ~" } }),
    );
    const cmd = await detectProveCommand(dir);
    expect(cmd).toEqual({ command: "npm", args: ["run", "test"], source: "package.json#scripts.test" });
  });

  it("takes the operator override as argv, not as a shell string", async () => {
    process.env.VERIT_PROVE_CMD = "node -e process.exit(0)";
    expect(await detectProveCommand(await tmp())).toEqual({
      command: "node",
      args: ["-e", "process.exit(0)"],
      source: "VERIT_PROVE_CMD",
    });
  });

  it("accepts the JSON array override form, keeping an argument with spaces", async () => {
    // the whitespace split mangles this; the array form keeps "my case" whole
    process.env.VERIT_PROVE_CMD = JSON.stringify(["pnpm", "test", "--", "my case"]);
    expect(await detectProveCommand(await tmp())).toEqual({
      command: "pnpm",
      args: ["test", "--", "my case"],
      source: "VERIT_PROVE_CMD",
    });
  });

  it("still splits the string override form on whitespace", async () => {
    process.env.VERIT_PROVE_CMD = "cargo test --all";
    expect(await detectProveCommand(await tmp())).toEqual({
      command: "cargo",
      args: ["test", "--all"],
      source: "VERIT_PROVE_CMD",
    });
  });

  it("refuses a malformed JSON array rather than mangling it", async () => {
    process.env.VERIT_PROVE_CMD = '["pnpm", "test"';
    expect(await detectProveCommand(await tmp())).toBeNull();
  });
});

describe("proveChildEnv", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    GH_TOKEN: "ghs_secret",
    VERIT_INGEST_TOKEN: "vit_secret",
    AWS_SECRET_ACCESS_KEY: "aws_secret",
    CARGO_HOME: "/Users/x/.cargo",
    npm_config_registry: "https://registry.npmjs.org",
  };

  it("keeps secrets out of the local child env", () => {
    const env = proveChildEnv(base);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.VERIT_INGEST_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // the command still runs: tools, home, toolchain and npm config survive
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.CARGO_HOME).toBe("/Users/x/.cargo");
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org");
    expect(env.CI).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });

  it("passes only the keys the operator names in VERIT_PROVE_ENV", () => {
    const env = proveChildEnv({
      ...base,
      VERIT_PROVE_ENV: "DATABASE_URL, MY_FLAG",
      DATABASE_URL: "postgres://localhost/x",
      MY_FLAG: "on",
    });
    expect(env.DATABASE_URL).toBe("postgres://localhost/x");
    expect(env.MY_FLAG).toBe("on");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps the full env on GitHub Actions, where the runner is the boundary", () => {
    const env = proveChildEnv({ ...base, GITHUB_ACTIONS: "true" });
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(env.CI).toBe("1");
  });
});

describe("prove runner", () => {
  it("refuses to run outside the repo the caller named", async () => {
    const dir = await tmp();
    const result = await Effect.runPromiseExit(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit" }),
    );
    expect(result._tag).toBe("Failure");
  });

  it("records the real exit code, duration and log tail of a failing command", async () => {
    process.env.VERIT_PROVE_CMD = "node -e console.log('hello');process.exit(3)";
    // run against this checkout, naming it correctly, so the guard passes
    const runner = makeProveRunner();
    const repo = await Effect.runPromise(runner.repoAt(process.cwd()));
    if (!repo) return; // not a GitHub clone (e.g. a tarball CI); guard is covered above
    const out = await Effect.runPromise(runner.run({ cwd: process.cwd(), expectRepo: repo }));
    expect(out.exitCode).toBe(3);
    expect(out.timedOut).toBe(false);
    expect(out.logTail).toContain("hello");
    expect(out.durationMs).toBeGreaterThan(0);
  });

  it("kills a command that overruns its timeout", async () => {
    process.env.VERIT_PROVE_CMD = "node -e setTimeout(()=>{},60000)";
    const runner = makeProveRunner();
    const repo = await Effect.runPromise(runner.repoAt(process.cwd()));
    if (!repo) return;
    const out = await Effect.runPromise(
      runner.run({ cwd: process.cwd(), expectRepo: repo, timeoutMs: 500 }),
    );
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0);
  }, 20_000);
});

describe("prove dirty-tree guard", () => {
  const git = (args: readonly string[], cwd: string) =>
    spawnSync("git", [...args], { cwd, encoding: "utf8" });

  const seedRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    // a github origin so the repo guard lets prove run at all
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);
    return dir;
  };

  it("refuses to a neutral outcome when the tree changed since the baseline", async () => {
    const dir = await seedRepo();
    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    // a mutation lands between the snapshot and prove: exactly what an escaped
    // lane would do to force a green tree.
    await writeFile(join(dir, "sneaked-in.txt"), "x");
    process.env.VERIT_PROVE_CMD = "node -e process.exit(0)";
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(out.refused).toContain("working tree changed");
    // the verdict is neutral, never success, and the command never ran.
    expect(proofVerdict(out)).toBe("neutral");
    expect(out.log).toBe("");
    expect(out.porcelainClean).toBe(false);
  });

  it("also refuses when HEAD moved but the tree stayed clean", async () => {
    const dir = await seedRepo();
    const baseline = await gitState(dir);
    // a second commit: HEAD moves, porcelain stays empty. A checkout swap must
    // still trip the guard, so the porcelain hash alone is not enough.
    await writeFile(join(dir, "second.txt"), "y");
    git(["add", "-A"], dir);
    git(["commit", "-qm", "second"], dir);
    process.env.VERIT_PROVE_CMD = "node -e process.exit(0)";
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(proofVerdict(out)).toBe("neutral");
  });

  it("refuses when a tracked file is doctored under skip-worktree, porcelain blinded", async () => {
    const dir = await seedRepo();
    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    // The evasion an escaped lane reaches for: mark the file skip-worktree so
    // `git status` stops reporting it, then doctor it on disk. porcelain stays
    // empty and HEAD holds still, so a guard that trusts porcelain alone sees a
    // clean tree and runs the doctored content. The guard must catch the hidden
    // index bit instead.
    git(["update-index", "--skip-worktree", "package.json"], dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" }, doctored: true }));
    // porcelain really is blind here: no path is reported despite the edit.
    expect(git(["status", "--porcelain"], dir).stdout).toBe("");
    process.env.VERIT_PROVE_CMD = "node -e process.exit(0)";
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(out.refused).toContain("working tree changed");
    expect(proofVerdict(out)).toBe("neutral");
    expect(out.log).toBe("");
  });

  it("also refuses under assume-unchanged, the other porcelain-blinding bit", async () => {
    const dir = await seedRepo();
    const baseline = await gitState(dir);
    git(["update-index", "--assume-unchanged", "package.json"], dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" }, doctored: true }));
    expect(git(["status", "--porcelain"], dir).stdout).toBe("");
    process.env.VERIT_PROVE_CMD = "node -e process.exit(0)";
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(proofVerdict(out)).toBe("neutral");
  });

  it("refuses when a detected suite's gitignored toolchain is rewritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    // the detected suite executes an ignored directory. porcelain and
    // ls-files -v never see writes there, so a snapshot that only hashes
    // git metadata lets the rewrite run to a green.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node toolchain/run.js" } }));
    await writeFile(join(dir, ".gitignore"), "toolchain/\n");
    await mkdir(join(dir, "toolchain"));
    await writeFile(join(dir, "toolchain", "run.js"), "process.exit(1)\n");
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);

    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    await writeFile(join(dir, "toolchain", "run.js"), "process.exit(0)\n");
    expect(git(["status", "--porcelain"], dir).stdout).toBe("");
    expect(git(["ls-files", "-v"], dir).stdout).not.toMatch(/toolchain/);

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(out.refused).toContain("working tree changed");
    expect(proofVerdict(out)).toBe("neutral");
    expect(out.log).toBe("");
  });

  it("refuses when a bare package.json script is shadowed from the ignored package-manager bin dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    // slashless script: every token fails normalizeRel. detectProveCommands
    // still runs `npm run test`, which resolves `node` from node_modules/.bin.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    await writeFile(join(dir, "check.js"), "process.exit(1)\n");
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);

    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    const shadow = join(dir, "node_modules", ".bin", "node");
    await writeFile(shadow, "#!/bin/sh\nexit 0\n");
    spawnSync("chmod", ["+x", shadow]);
    expect(git(["status", "--porcelain"], dir).stdout).toBe("");
    expect(git(["ls-files", "-v"], dir).stdout).not.toMatch(/node_modules/);

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(out.refused).toContain("working tree changed");
    expect(proofVerdict(out)).toBe("neutral");
    expect(out.log).toBe("");
  });

  it("does not go green when an ignored package the suite requires is rewritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    // slashless script, load from an ignored package, not a .bin shim.
    // Hashing node_modules/.bin leaves this write invisible.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    await writeFile(
      join(dir, "check.js"),
      'try { process.exit(require("./node_modules/payload/index.js") === "pass" ? 0 : 1); } catch { process.exit(1); }\n',
    );
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await mkdir(join(dir, "node_modules", "payload"), { recursive: true });
    await writeFile(join(dir, "node_modules", "payload", "index.js"), "module.exports = 'fail';\n");
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);

    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    await writeFile(join(dir, "node_modules", "payload", "index.js"), "module.exports = 'pass';\n");
    expect(git(["status", "--porcelain"], dir).stdout).toBe("");
    expect(git(["ls-files", "-v"], dir).stdout).not.toMatch(/node_modules/);

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(proofVerdict(out)).not.toBe("success");
    expect(out.refused != null || out.exitCode !== 0).toBe(true);
  }, 15_000);

  it("does not go green when a committed export-ignore file is the failing suite input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    // missing failing.js is a pass. git archive honors export-ignore and
    // omits the committed failing file, so an archive-based prove tree
    // would go green on a checkout GitHub would still merge.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    await writeFile(
      join(dir, "check.js"),
      'const fs=require("fs");process.exit(fs.existsSync("failing.js")?1:0);\n',
    );
    await writeFile(join(dir, "failing.js"), "throw new Error('must fail');\n");
    await writeFile(join(dir, ".gitattributes"), "failing.js export-ignore\n");
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);
    expect(git(["show", "HEAD:failing.js"], dir).status).toBe(0);
    const arch = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: dir, encoding: "buffer" });
    expect(arch.status).toBe(0);
    const names = spawnSync("tar", ["-tf", "-"], { input: arch.stdout, encoding: "utf8" }).stdout;
    expect(names).toContain("check.js");
    expect(names.split("\n")).not.toContain("failing.js");

    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(proofVerdict(out)).not.toBe("success");
    expect(out.refused != null || out.exitCode !== 0).toBe(true);
  }, 15_000);

  it("does not go green when a committed symlink to a failing blob is the suite input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    // a real checkout follows test.js to failing.js. ls-tree lists the
    // link as 120000 blob. cat-file of that blob is the target path
    // string. writeFile of those bytes makes a regular file, and the
    // suite that looks for "must fail" in test.js then goes green.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    await writeFile(
      join(dir, "check.js"),
      'const fs=require("fs");process.exit(fs.readFileSync("test.js","utf8").includes("must fail")?1:0);\n',
    );
    await writeFile(join(dir, "failing.js"), "must fail\n");
    await symlink("failing.js", join(dir, "test.js"));
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);

    expect((await lstat(join(dir, "test.js"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, "test.js"), "utf8")).toContain("must fail");
    expect(git(["ls-tree", "HEAD", "test.js"], dir).stdout).toMatch(/^120000 blob /);
    expect(git(["cat-file", "blob", "HEAD:test.js"], dir).stdout).toBe("failing.js");

    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(proofVerdict(out)).not.toBe("success");
    expect(out.refused != null || out.exitCode !== 0).toBe(true);
  }, 15_000);

  it("does not go green when a committed gitlink named vendor is the failing suite input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verit-guard-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    // missing vendor is a pass. ls-tree lists a gitlink as 160000 commit.
    // A loop that skips non-blobs never creates the path. checkout-index
    // and a GitHub checkout make an empty vendor directory, so the suite
    // fails there and goes green on a prove tree that omitted the path.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    await writeFile(
      join(dir, "check.js"),
      'const fs=require("fs");process.exit(fs.existsSync("vendor")?1:0);\n',
    );
    git(["add", "-A"], dir);
    git(
      ["update-index", "--add", "--cacheinfo", "160000,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,vendor"],
      dir,
    );
    git(["commit", "-qm", "seed"], dir);
    await mkdir(join(dir, "vendor"));

    expect(git(["ls-tree", "HEAD", "vendor"], dir).stdout).toMatch(/^160000 commit /);
    const checked = await mkdtemp(join(tmpdir(), "verit-gitlink-co-"));
    expect(git(["checkout-index", `--prefix=${checked}/`, "-a"], dir).status).toBe(0);
    expect((await lstat(join(checked, "vendor"))).isDirectory()).toBe(true);
    expect(existsSync(join(dir, "vendor"))).toBe(true);

    const baseline = await gitState(dir);
    expect(baseline).not.toBeNull();
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(proofVerdict(out)).not.toBe("success");
    expect(out.refused != null || out.exitCode !== 0).toBe(true);
  }, 15_000);

  it("runs and records head sha and the clean flag when the tree held still", async () => {
    const dir = await seedRepo();
    const baseline = await gitState(dir);
    process.env.VERIT_PROVE_CMD = "node -e process.exit(0)";
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeUndefined();
    expect(out.exitCode).toBe(0);
    expect(out.headSha).toBe(baseline?.headSha);
    expect(out.porcelainClean).toBe(true);
    expect(proofVerdict(out)).toBe("success");
  }, 15_000);
});

describe("prove multi-suite and detection-driven runs", () => {
  const git = (args: readonly string[], cwd: string) =>
    spawnSync("git", [...args], { cwd, encoding: "utf8" });

  /** A committed checkout with a github origin, seeded with the given files. */
  const seed = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "verit-suite-"));
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], dir);
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body);
    }
    git(["add", "-A"], dir);
    git(["commit", "-qm", "seed"], dir);
    return dir;
  };

  it("produces a real go test proof for a go-only repo", async () => {
    if (!hasBin("go")) return; // no toolchain in this environment; detection is covered above
    const dir = await seed({
      "go.mod": "module example.com/x\n\ngo 1.20\n",
      "x.go": "package x\n\nfunc Add(a, b int) int { return a + b }\n",
      "x_test.go":
        'package x\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 2) != 4 {\n\t\tt.Fatal("math is broken")\n\t}\n}\n',
    });
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", timeoutMs: 120_000 }),
    );
    expect(out.source).toBe("go.mod");
    expect(out.command).toBe("go test ./...");
    expect(out.exitCode).toBe(0);
    expect(out.suites).toBeUndefined(); // one suite: rendered as a single proof
    expect(out.log.toLowerCase()).toMatch(/ok|pass/);
    expect(proofVerdict(out)).toBe("success");
  }, 130_000);

  it("runs several suites with independent exit codes and one combined outcome", async () => {
    if (!hasBin("go")) return;
    // go (passes) beside a package.json test (fails): the whole run must fail,
    // and both suites must appear with their own exit codes.
    const dir = await seed({
      "go.mod": "module example.com/x\n\ngo 1.20\n",
      "x_test.go": 'package x\n\nimport "testing"\n\nfunc TestOk(t *testing.T) {}\n',
      "package.json": JSON.stringify({ scripts: { test: "node -e process.exit(2)" } }),
    });
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit", timeoutMs: 120_000 }),
    );
    expect(out.suites).toBeDefined();
    expect(out.suites).toHaveLength(2);
    const bySource = Object.fromEntries((out.suites ?? []).map((s) => [s.source, s]));
    expect(bySource["go.mod"]?.exitCode).toBe(0);
    expect(bySource["package.json#scripts.test"]?.exitCode).toBe(2);
    // any suite failing = the combined run fails
    expect(out.exitCode).not.toBe(0);
    expect(proofVerdict(out)).toBe("failure");
  }, 130_000);

  it("a single suite whose runner is missing is skipped, never a pass", async () => {
    // the command is found (an override), but the binary does not exist. The
    // suite did not run, so the outcome must not read as green.
    const dir = await seed({ "README.md": "x\n" });
    process.env.VERIT_PROVE_CMD = "verit-nonexistent-runner-xyz test";
    try {
      const out = await Effect.runPromise(
        makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit" }),
      );
      expect(out.suites).toBeDefined();
      expect(out.suites?.[0]?.skipped).toBeTruthy();
      expect(out.exitCode).not.toBe(0); // never green while the suite did not run
    } finally {
      delete process.env.VERIT_PROVE_CMD;
    }
  });

  it("returns a probed, neutral outcome when no test command is found", async () => {
    // a repo with a manifest but no test command: nothing runs, nothing green
    const dir = await seed({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit" }),
    );
    expect(out.refused).toBeTruthy();
    expect(out.probed).toBeDefined();
    expect(out.probed).toContain("package.json (no test script)");
    expect(out.probed?.some((p) => p.startsWith("go.mod"))).toBe(true);
    expect(proofVerdict(out)).toBe("neutral");
  });
});
