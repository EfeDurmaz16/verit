import type { Understanding } from "@verit/domain";

/* Review verbs. `prove` is real (see ./prove.ts) and `post` is a Check Run
   (see ./check.ts); risk and patch are still stubs until their agents land. */

export const stubRisk = (u: Understanding): Understanding => ({
  ...u,
  risks: [
    ...u.risks,
    {
      area: "review-verb",
      note: "risk verb stub, replace with agent pass",
      source: "reviewer",
    },
  ],
});

export const stubPatch = (): { summary: string; diff: string } => ({
  summary: "No auto-patch in v0 stub",
  diff: "",
});
