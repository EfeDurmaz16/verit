import { normalizeExecutionMemory } from "@verit/domain";
import type { ProveCommand } from "@verit/ports";
import { describe, expect, it } from "vitest";
import { repeatsFor, resolveManagedExecution } from "./managed-execution";

/*
 * The promise being tested is the boring one: a maintainer installs verit and
 * gets evidence, without writing a sandbox recipe and without writing a probe.
 * So every case below asks the same question, which is whether a human had to
 * be involved.
 */

const suite: ProveCommand = { command: "pnpm", args: ["test"], source: "package.json" };

const resolve = (over: Partial<Parameters<typeof resolveManagedExecution>[0]> = {}) =>
  resolveManagedExecution({
    repoFiles: ["package.json", "pnpm-lock.yaml", "src/a.ts"],
    detectedSuites: [suite],
    ...over,
  });

describe("nothing has to be configured for an ordinary repository", () => {
  it("detects the install from the lockfile it finds", () => {
    const out = resolve();
    expect(out.prepare).toEqual({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      source: "pnpm-lock.yaml",
    });
    expect(out.prepareSource).toBe("detected");
    expect(out.needsMaintainerInput).toBeNull();
  });

  it("picks the lockfile's manager over the bare manifest", () => {
    expect(resolve({ repoFiles: ["package.json", "yarn.lock"] }).prepare?.command).toBe("yarn");
    expect(resolve({ repoFiles: ["package.json"] }).prepare?.command).toBe("npm");
  });

  it("handles a repository in another language without being told", () => {
    expect(resolve({ repoFiles: ["go.mod", "go.sum"] }).prepare?.command).toBe("go");
    expect(resolve({ repoFiles: ["pyproject.toml", "uv.lock"] }).prepare?.command).toBe("uv");
    expect(resolve({ repoFiles: ["Gemfile", "Gemfile.lock"] }).prepare?.command).toBe("bundle");
  });

  it("asks for nothing when there is nothing to install", () => {
    const out = resolve({ repoFiles: ["main.c", "Makefile"] });
    expect(out.prepare).toBeNull();
    expect(out.prepareSource).toBe("none");
    expect(out.needsMaintainerInput).toBeNull();
  });
});

describe("a run that already worked is cheaper than a guess", () => {
  const remembered = normalizeExecutionMemory({
    repoId: "r1",
    dependencyDigest: "dep-a",
    installCommand: "pnpm install --offline --frozen-lockfile",
    installOutcome: "ok",
    observedAt: "2026-08-30T00:00:00.000Z",
  });

  it("reuses the remembered command over the detected one", () => {
    const out = resolve({ rememberedInstall: remembered });
    expect(out.prepare?.args).toEqual(["install", "--offline", "--frozen-lockfile"]);
    expect(out.prepareSource).toBe("remembered");
  });

  it("falls back to detection when the memory is empty", () => {
    const out = resolve({
      rememberedInstall: normalizeExecutionMemory({ repoId: "r1", observedAt: "x" }),
    });
    expect(out.prepareSource).toBe("detected");
  });

  it("lets the maintainer's own command win over both", () => {
    const mine: ProveCommand = { command: "make", args: ["deps"], source: "input" };
    const out = resolve({ rememberedInstall: remembered, overrideInstall: mine });
    expect(out.prepare).toEqual(mine);
  });
});

describe("a repository that flaked before is run more carefully", () => {
  it("runs twice by default", () => {
    expect(repeatsFor(null)).toBe(2);
    expect(repeatsFor({ runs: 10, unstable: 0 })).toBe(2);
  });

  it("runs three times once it has ever flaked", () => {
    expect(repeatsFor({ runs: 10, unstable: 1 })).toBe(3);
  });

  it("runs five times when it flakes half the time", () => {
    expect(repeatsFor({ runs: 10, unstable: 5 })).toBe(5);
  });

  it("carries the repeat count into the run", () => {
    expect(resolve({ stabilityHistory: { runs: 4, unstable: 2 } }).runsPerSide).toBe(5);
  });
});

describe("the policy digest changes when the experiment changes", () => {
  it("differs between isolation kinds", () => {
    const a = resolve({ isolation: "runner-ephemeral" }).policy.digest;
    const b = resolve({ isolation: "managed-ephemeral" }).policy.digest;
    expect(a).not.toBe(b);
  });

  it("differs when the preparation differs", () => {
    const a = resolve().policy.digest;
    const b = resolve({ repoFiles: ["package.json"] }).policy.digest;
    expect(a).not.toBe(b);
  });

  it("differs when the repeat count differs", () => {
    const a = resolve().policy.digest;
    const b = resolve({ stabilityHistory: { runs: 2, unstable: 2 } }).policy.digest;
    expect(a).not.toBe(b);
  });

  it("is stable for the same inputs", () => {
    expect(resolve().policy.digest).toBe(resolve().policy.digest);
  });
});

describe("the one thing that cannot be defaulted", () => {
  it("says what is missing when the repository verifies nothing", () => {
    const out = resolve({ detectedSuites: [] });
    expect(out.needsMaintainerInput).toContain("no way this repository verifies itself");
    expect(out.needsMaintainerInput).toContain("prove-command");
  });

  it("does not ask for a sandbox recipe", () => {
    const asked = resolve({ detectedSuites: [] }).needsMaintainerInput ?? "";
    expect(asked.toLowerCase()).not.toContain("sandbox");
    expect(asked.toLowerCase()).not.toContain("probe");
  });
});
