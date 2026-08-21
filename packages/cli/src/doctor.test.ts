import { describe, expect, it } from "vitest";
import { evaluateDoctor, type DoctorFacts } from "./doctor";

const healthy: DoctorFacts = {
  nodeMajor: 22,
  pnpmVersion: "11.9.0",
  hasGithubCredential: true,
  ghDetail: "GITHUB_TOKEN is set",
  lane: { state: "ok", detail: "provider anthropic, model claude-opus-5, key present" },
  proveCwd: {
    requested: true,
    path: "/work/repo",
    exists: true,
    repoSlug: "owner/repo",
    command: "pnpm run test",
  },
};

const statusOf = (facts: DoctorFacts, name: string): string =>
  evaluateDoctor(facts).checks.find((c) => c.name === name)?.status ?? "missing";

describe("evaluateDoctor", () => {
  it("passes a healthy environment with exit 0", () => {
    const { checks, exitCode } = evaluateDoctor(healthy);
    expect(exitCode).toBe(0);
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("fails when the lane is opted into but broken", () => {
    const facts = { ...healthy, lane: { state: "error", detail: "VERIT_LANE_MODEL is required" } as const };
    expect(statusOf(facts, "lane")).toBe("fail");
    expect(evaluateDoctor(facts).exitCode).toBe(1);
  });

  it("only warns when the lane is disabled, never fails", () => {
    const facts = { ...healthy, lane: { state: "disabled", detail: "off" } as const };
    expect(statusOf(facts, "lane")).toBe("warn");
    expect(evaluateDoctor(facts).exitCode).toBe(0);
  });

  it("fails when a requested prove cwd does not exist", () => {
    const facts = { ...healthy, proveCwd: { ...healthy.proveCwd, exists: false } };
    expect(statusOf(facts, "prove cwd")).toBe("fail");
    expect(evaluateDoctor(facts).exitCode).toBe(1);
  });

  it("fails on a node too old to run verit", () => {
    expect(statusOf({ ...healthy, nodeMajor: 18 }, "node")).toBe("fail");
  });

  it("warns, does not fail, when no github credential is present", () => {
    const facts = { ...healthy, hasGithubCredential: false, ghDetail: "none" };
    expect(statusOf(facts, "github auth")).toBe("warn");
    expect(evaluateDoctor(facts).exitCode).toBe(0);
  });

  it("warns when the checkout has no detectable test command", () => {
    const facts = { ...healthy, proveCwd: { ...healthy.proveCwd, command: null } };
    expect(statusOf(facts, "prove cwd")).toBe("warn");
    expect(evaluateDoctor(facts).exitCode).toBe(0);
  });
});
