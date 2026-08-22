import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { laneConfigFromEnv } from "./index";
import { DEFAULT_LANE_TIER, parseLaneTier, resolveLaneTier } from "./tiers";

/** The default slugs, asserted here (test code) so a silent table edit is caught.
    These strings live in the product only in tiers.ts and the README matrix. */
const FAST = "openai/gpt-5.6-luna";
const TRIAGE = "openai/gpt-5.6-luna";
const BALANCED = "anthropic/claude-sonnet-5";
const MAX = "anthropic/claude-opus-5";

describe("parseLaneTier", () => {
  it("defaults unset and garbage to balanced, keeps valid tiers", () => {
    expect(parseLaneTier(undefined)).toBe("balanced");
    expect(parseLaneTier("")).toBe("balanced");
    expect(parseLaneTier("blanaced")).toBe("balanced");
    expect(DEFAULT_LANE_TIER).toBe("balanced");
    expect(parseLaneTier("fast")).toBe("fast");
    expect(parseLaneTier("max")).toBe("max");
  });
});

describe("resolveLaneTier", () => {
  it("fast is a single judge call, no triage", () => {
    expect(resolveLaneTier("fast", {})).toEqual({ judge: FAST });
  });

  it("balanced and max add a triage map pass", () => {
    expect(resolveLaneTier("balanced", {})).toEqual({ triage: TRIAGE, judge: BALANCED });
    expect(resolveLaneTier("max", {})).toEqual({ triage: TRIAGE, judge: MAX });
  });

  it("honors per-tier judge and triage env overrides", () => {
    expect(
      resolveLaneTier("balanced", { VERIT_LANE_TIER_BALANCED_JUDGE: "x/custom-judge" }),
    ).toEqual({ triage: TRIAGE, judge: "x/custom-judge" });
    expect(
      resolveLaneTier("max", { VERIT_LANE_TIER_MAX_TRIAGE: "x/custom-triage" }),
    ).toEqual({ triage: "x/custom-triage", judge: MAX });
  });
});

describe("laneConfigFromEnv tier resolution", () => {
  const base = { VERIT_LANE_PROVIDER: "openai-compat", VERIT_LANE_API_KEY: "k" };

  it("takes the judge from the tier when VERIT_LANE_MODEL is unset", () => {
    const cfg = laneConfigFromEnv({ ...base, VERIT_LANE_TIER: "max" });
    expect(cfg.judge).toBe(MAX);
    expect(cfg.triage).toBe(TRIAGE);
    expect(cfg.tier).toBe("max");
  });

  it("VERIT_LANE_MODEL is a legacy single pin: moves the judge AND drops triage", () => {
    const cfg = laneConfigFromEnv({
      ...base,
      VERIT_LANE_TIER: "max",
      VERIT_LANE_MODEL: "legacy/pinned-model",
    });
    expect(cfg.judge).toBe("legacy/pinned-model");
    // A pin means one model, one pass. It never fires the second, cross-provider,
    // doomed triage call that an existing single-model setup never asked for.
    expect(cfg.triage).toBeUndefined();
  });

  it("a per-tier judge override customizes the judge but keeps the tier's triage", () => {
    // The migration path for anyone who wants a custom judge WITH triage: the
    // per-tier override, not the legacy single pin.
    const cfg = laneConfigFromEnv({
      ...base,
      VERIT_LANE_TIER: "max",
      VERIT_LANE_TIER_MAX_JUDGE: "x/custom-judge",
    });
    expect(cfg.judge).toBe("x/custom-judge");
    expect(cfg.triage).toBe(TRIAGE);
  });

  it("defaults to the balanced tier when VERIT_LANE_TIER is unset", () => {
    const cfg = laneConfigFromEnv(base);
    expect(cfg.tier).toBe("balanced");
    expect(cfg.judge).toBe(BALANCED);
  });
});

/*
 * Slug indirection: the pipeline logic (pipeline.ts + loop.ts, the runLane
 * source) must never inline a model id. Grep proves it: model slugs appear only
 * in tiers.ts, and index.ts references the tier config rather than any literal.
 */
describe("no model slug leaks into the pipeline logic", () => {
  const read = (name: string): string =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
  const slugs = [FAST, BALANCED, MAX, "openai/", "anthropic/"];

  it("pipeline.ts and loop.ts contain no model slug literal", () => {
    for (const file of ["./pipeline.ts", "./loop.ts"]) {
      const src = read(file);
      for (const slug of slugs) {
        expect(src, `${file} must not name ${slug}`).not.toContain(slug);
      }
    }
  });

  it("tiers.ts is the one place the slugs live, and index.ts references it", () => {
    const tiers = read("./tiers.ts");
    for (const slug of [FAST, BALANCED, MAX]) expect(tiers).toContain(slug);
    expect(read("./index.ts")).toContain('from "./tiers"');
  });
});
