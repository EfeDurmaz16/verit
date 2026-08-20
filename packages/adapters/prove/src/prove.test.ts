import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { proofVerdict } from "@verit/domain";
import { afterEach, describe, expect, it } from "vitest";
import { detectProveCommand, gitState, makeProveRunner, proveChildEnv } from "./index";

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

  it("falls back to build, then to the manifest runners", async () => {
    const js = await tmp();
    await writeFile(join(js, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect((await detectProveCommand(js))?.args).toEqual(["run", "build"]);

    const rust = await tmp();
    await writeFile(join(rust, "Cargo.toml"), "[package]\nname = 'x'\n");
    expect(await detectProveCommand(rust)).toMatchObject({ command: "cargo", args: ["test"] });

    const py = await tmp();
    await writeFile(join(py, "pyproject.toml"), "[project]\nname = 'x'\n");
    expect((await detectProveCommand(py))?.command).toBe("pytest");

    expect(await detectProveCommand(await tmp())).toBeNull();
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
  });
});
