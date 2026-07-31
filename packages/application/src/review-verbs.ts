import type { Understanding } from "@cyclops/domain";

/** Stub review verbs — prove/risk/patch/post until live agents land. */
export const stubProve = (u: Understanding): Understanding => ({
  ...u,
  proof_refs:
    u.proof_refs.length > 0
      ? u.proof_refs
      : [{ kind: "command", label: "stub-prove", value: "cyclops review --dry-run" }],
});

export const stubRisk = (u: Understanding): Understanding => ({
  ...u,
  risks: [
    ...u.risks,
    {
      area: "review-verb",
      note: "risk verb stub — replace with agent pass",
      source: "reviewer",
    },
  ],
});

export const stubPatch = (): { summary: string; diff: string } => ({
  summary: "No auto-patch in v0 stub",
  diff: "",
});

export const stubPost = (spec: unknown): { kind: "json_render_spec"; body: string } => ({
  kind: "json_render_spec",
  body: JSON.stringify(spec),
});
