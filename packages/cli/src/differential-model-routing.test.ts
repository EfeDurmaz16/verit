import { resolveLaneTier } from "@verit/lane";
import { describe, expect, it } from "vitest";
import { makeDifferentialDeps } from "./differential";

/*
 * Which model does which job.
 *
 * Naming a change's claims and writing a probe for one are reading tasks over
 * material already in front of the model. The judge is for the call whose
 * output is an opinion. Getting this wrong is not a correctness bug, it is a
 * bill: on the balanced tier these two passes were most of the cost of a
 * review.
 */

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  VERIT_LANE_PROVIDER: "openai-compat",
  VERIT_LANE_API_KEY: "sk-test",
  VERIT_LANE_BASE_URL: "https://openrouter.ai/api/v1",
  ...over,
});

const withEnv = <T>(vars: NodeJS.ProcessEnv, f: () => T): T => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VERIT_LANE")) delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return f();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("VERIT_LANE")) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
};

const deps = (vars: NodeJS.ProcessEnv) =>
  withEnv(vars, () =>
    makeDifferentialDeps({ repoDir: "/tmp/repo", baseSha: "aaaa", headSha: "bbbb" }),
  );

describe("the map passes run on the tier's cheap model", () => {
  it("has a distinct triage model to route them to on the default tier", () => {
    const tier = withEnv(env(), () => resolveLaneTier("balanced", process.env));
    expect(tier.triage).toBeDefined();
    expect(tier.triage).not.toBe(tier.judge);
  });

  it("builds without reaching for the judge when a triage model exists", () => {
    expect(() => deps(env({ VERIT_LANE_TIER: "balanced" }))).not.toThrow();
    expect(() => deps(env({ VERIT_LANE_TIER: "max" }))).not.toThrow();
  });

  it("still works on a tier that has no cheaper model", () => {
    const tier = withEnv(env(), () => resolveLaneTier("fast", process.env));
    expect(tier.triage).toBeUndefined();
    expect(() => deps(env({ VERIT_LANE_TIER: "fast" }))).not.toThrow();
  });

  it("follows an operator's own triage override", () => {
    const tier = withEnv(
      env({ VERIT_LANE_TIER_BALANCED_TRIAGE: "some/other-cheap-model" }),
      () => resolveLaneTier("balanced", process.env),
    );
    expect(tier.triage).toBe("some/other-cheap-model");
  });
});
