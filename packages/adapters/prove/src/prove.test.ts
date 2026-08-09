import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { detectProveCommand, makeProveRunner } from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "cyclops-prove-"));

afterEach(() => {
  delete process.env.CYCLOPS_PROVE_CMD;
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
    // which we never read — we only ever run `npm run test`
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest; rm -rf ~" } }),
    );
    const cmd = await detectProveCommand(dir);
    expect(cmd).toEqual({ command: "npm", args: ["run", "test"], source: "package.json#scripts.test" });
  });

  it("takes the operator override as argv, not as a shell string", async () => {
    process.env.CYCLOPS_PROVE_CMD = "node -e process.exit(0)";
    expect(await detectProveCommand(await tmp())).toEqual({
      command: "node",
      args: ["-e", "process.exit(0)"],
      source: "CYCLOPS_PROVE_CMD",
    });
  });
});

describe("prove runner", () => {
  it("refuses to run outside the repo the caller named", async () => {
    const dir = await tmp();
    const result = await Effect.runPromiseExit(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/cyclops" }),
    );
    expect(result._tag).toBe("Failure");
  });

  it("records the real exit code, duration and log tail of a failing command", async () => {
    process.env.CYCLOPS_PROVE_CMD = "node -e console.log('hello');process.exit(3)";
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
    process.env.CYCLOPS_PROVE_CMD = "node -e setTimeout(()=>{},60000)";
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
