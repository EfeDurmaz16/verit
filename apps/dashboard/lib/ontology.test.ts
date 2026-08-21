import { decodeRunUpload, type RunUpload } from "@verit/domain";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  assembleContinuityPack,
  type Decision,
  deriveDecision,
  deriveObservation,
  deriveRisks,
  exportOntologySqlite,
  extractPaths,
  extractRefs,
  importOntologySqlite,
  type LedgerRisk,
  type OntologySnapshot,
  type ProofObservation,
  proofProfiles,
  renderContinuityPack,
  resolveRisks,
} from "./ontology";

const upload = (over: Record<string, unknown> = {}): RunUpload => {
  const decoded = decodeRunUpload({
    repo: "acme/widgets",
    run: {
      id: "run:1",
      repoId: "repo:acme/widgets",
      skillPackHash: "a".repeat(64),
      domain: "GENERAL",
      createdAt: "2026-08-20T10:00:00.000Z",
    },
    understanding: {
      what: "Adds a retry to sender.ts for the webhook path.",
      why: "Deliveries dropped when the receiver restarted.",
      how: "sender.ts and lib/retry.ts back off three times.",
      proof_refs: [],
      risks: [{ area: "delivery", note: "retries can reorder events", source: "reviewer" }],
    },
    proofSpec: { root: "workspace", elements: { workspace: { type: "Workspace", props: {} } } },
    pr: { number: 7, title: "retry webhook sends", url: "https://x.test/7", author: "efe" },
    prove: {
      command: "pnpm test",
      source: "package.json",
      repo: "acme/widgets",
      exitCode: 0,
      durationMs: 1200,
      timedOut: false,
      logTail: "green",
      startedAt: "2026-08-20T10:00:01.000Z",
    },
    ...over,
  });
  if (Either.isLeft(decoded)) throw new Error("test upload fails the schema");
  return decoded.right;
};

describe("extraction", () => {
  it("pulls file paths out of prose", () => {
    expect(extractPaths("touches sender.ts and lib/retry.ts, not README")).toEqual([
      "sender.ts",
      "lib/retry.ts",
    ]);
  });

  it("pulls PR references, ignoring anchors without a number", () => {
    expect(extractRefs("follow-up to #12, stacked on #8, see # nothing")).toEqual([12, 8]);
  });
});

describe("derive from a run", () => {
  it("makes a decision that cites its run and touched files", () => {
    const d = deriveDecision(upload(), "2026-08-20T10:00:00.000Z");
    expect(d.runId).toBe("run:1");
    expect(d.what).toContain("retry");
    expect(d.touchedPaths).toContain("sender.ts");
    expect(d.touchedPaths).toContain("lib/retry.ts");
    expect(d.proofVerdict).toBe("success");
    expect(d.mergedAt).toBeNull();
  });

  it("opens one risk per Understanding risk", () => {
    const risks = deriveRisks(upload(), "2026-08-20T10:00:00.000Z");
    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({ area: "delivery", status: "open", ord: 0 });
  });

  it("records a proof observation only when the run proved something", () => {
    expect(deriveObservation(upload(), "t")?.ok).toBe(true);
    expect(deriveObservation(upload({ prove: undefined }), "t")).toBeNull();
  });

  it("aggregates observations into a pass rate and flakiness", () => {
    const obs = (runId: string, ok: boolean): ProofObservation => ({
      runId,
      repoId: "acme/widgets",
      command: "pnpm test",
      source: "package.json",
      ok,
      durationMs: 1,
      createdAt: "t",
    });
    const [p] = proofProfiles([obs("a", true), obs("b", true), obs("c", false), obs("d", true)]);
    expect(p).toMatchObject({ command: "pnpm test", runs: 4, passes: 3, passRate: 0.75 });
    expect(p?.flakiness).toBeCloseTo(0.25);
  });
});

// A synthetic 3-PR stacked series, all by one author. PR1 and PR2 are merged
// and each left an open risk. PR3 is the new PR under review.
const decision = (over: Partial<Decision>): Decision => ({
  runId: "run:x",
  repoId: "acme/widgets",
  prNumber: null,
  prAuthor: "efe",
  prTitle: "",
  headSha: null,
  what: "",
  why: "",
  touchedPaths: [],
  touchedSymbols: [],
  refs: [],
  proofVerdict: "success",
  mergedAt: null,
  createdAt: "2026-08-20T10:00:00.000Z",
  ...over,
});

const risk = (over: Partial<LedgerRisk>): LedgerRisk => ({
  runId: "run:x",
  ord: 0,
  repoId: "acme/widgets",
  prNumber: null,
  area: "delivery",
  note: "",
  source: "reviewer",
  status: "open",
  closedByRun: null,
  closedReason: null,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
  ...over,
});

const stackedSeries = (): OntologySnapshot => ({
  repoId: "acme/widgets",
  decisions: [
    decision({
      runId: "run:1",
      prNumber: 1,
      what: "Add the webhook sender.",
      touchedPaths: ["sender.ts"],
      mergedAt: "2026-08-18T10:00:00.000Z",
      createdAt: "2026-08-18T10:00:00.000Z",
    }),
    decision({
      runId: "run:2",
      prNumber: 2,
      what: "Add retries to the sender.",
      touchedPaths: ["sender.ts", "lib/retry.ts"],
      refs: [1],
      mergedAt: "2026-08-19T10:00:00.000Z",
      createdAt: "2026-08-19T10:00:00.000Z",
    }),
  ],
  risks: [
    risk({ runId: "run:1", prNumber: 1, area: "auth", note: "sender skips token scoping" }),
    risk({ runId: "run:2", prNumber: 2, area: "ordering", note: "retries can reorder events" }),
  ],
  observations: [],
});

describe("continuity pack", () => {
  it("references the earlier decisions and their open risks for a stacked PR3", () => {
    const pack = assembleContinuityPack(stackedSeries(), {
      prNumber: 3,
      author: "efe",
      touchedPaths: ["sender.ts", "lib/retry.ts"],
      refs: [2],
    });

    // Both merged predecessors surface: PR2 by path and reference, PR1 by path.
    expect(pack.decisions.map((d) => d.prNumber)).toEqual([2, 1]);
    // Both still-open risks come along, cited to their runs.
    expect(pack.openRisks.map((r) => r.area).sort()).toEqual(["auth", "ordering"]);
    expect(pack.citations).toContain("#2 (run:2)");
    expect(pack.citations).toContain("#1 (run:1)");

    const text = renderContinuityPack(pack);
    expect(text).toContain("#2 (run:2");
    expect(text).toContain("Still-open risks");
  });

  it("skips an unmerged predecessor and other authors' PRs", () => {
    const snap = stackedSeries();
    const withNoise: OntologySnapshot = {
      ...snap,
      decisions: [
        ...snap.decisions,
        decision({ runId: "run:9", prNumber: 9, touchedPaths: ["sender.ts"], mergedAt: null }),
        decision({
          runId: "run:8",
          prNumber: 8,
          prAuthor: "someone-else",
          touchedPaths: ["sender.ts"],
          mergedAt: "2026-08-19T10:00:00.000Z",
        }),
      ],
    };
    const pack = assembleContinuityPack(withNoise, {
      prNumber: 3,
      author: "efe",
      touchedPaths: ["sender.ts"],
      refs: [],
    });
    expect(pack.decisions.map((d) => d.runId)).not.toContain("run:9");
    expect(pack.decisions.map((d) => d.runId)).not.toContain("run:8");
  });

  it("is empty prose when there is no history", () => {
    expect(
      renderContinuityPack(
        assembleContinuityPack(stackedSeries(), {
          prNumber: 3,
          author: "nobody",
          touchedPaths: [],
          refs: [],
        }),
      ),
    ).toBe("");
  });
});

describe("closing risks against a later proof", () => {
  const open = stackedSeries().risks;

  it("confirms a risk when a referencing run's proof fails", () => {
    const closed = resolveRisks(
      open,
      { runId: "run:3", refs: [2], touchedPaths: [], proofVerdict: "failure" },
      "2026-08-20T10:00:00.000Z",
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ area: "ordering", status: "confirmed", closedByRun: "run:3" });
  });

  it("refutes a risk when a run that touches its area proves green", () => {
    const closed = resolveRisks(
      open,
      { runId: "run:3", refs: [], touchedPaths: ["lib/auth.ts"], proofVerdict: "success" },
      "2026-08-20T10:00:00.000Z",
    );
    expect(closed.map((r) => r.area)).toEqual(["auth"]);
    expect(closed[0]?.status).toBe("refuted");
  });

  it("leaves everything open when the run did not prove anything", () => {
    expect(
      resolveRisks(open, { runId: "run:3", refs: [1, 2], touchedPaths: [], proofVerdict: "neutral" }, "t"),
    ).toEqual([]);
  });
});

describe("sqlite export round-trips losslessly", () => {
  it("export then import equals the source snapshot", () => {
    const source: OntologySnapshot = {
      repoId: "acme/widgets",
      decisions: [
        decision({
          runId: "run:1",
          prNumber: 1,
          prTitle: "add sender",
          headSha: "abc",
          what: "Add the webhook sender.",
          why: "Needed a sender.",
          touchedPaths: ["sender.ts"],
          touchedSymbols: ["send"],
          refs: [],
          mergedAt: "2026-08-18T10:00:00.000Z",
        }),
        decision({
          runId: "run:2",
          prNumber: null,
          prAuthor: null,
          prTitle: null,
          what: "Local dogfood run.",
          why: "No PR.",
          proofVerdict: "neutral",
          refs: [1, 4],
        }),
      ],
      risks: [
        risk({ runId: "run:1", ord: 0, prNumber: 1, area: "auth", note: "token scoping" }),
        risk({
          runId: "run:1",
          ord: 1,
          prNumber: 1,
          area: "auth",
          note: "same area twice",
          status: "confirmed",
          closedByRun: "run:2",
          closedReason: "proof failed in run:2",
        }),
      ],
      observations: [
        {
          runId: "run:1",
          repoId: "acme/widgets",
          command: "pnpm test",
          source: "package.json",
          ok: true,
          durationMs: 1200,
          createdAt: "2026-08-18T10:00:00.000Z",
        },
        {
          runId: "run:2",
          repoId: "acme/widgets",
          command: "cargo test",
          source: null,
          ok: false,
          durationMs: null,
          createdAt: "2026-08-19T10:00:00.000Z",
        },
      ],
    };

    const back = importOntologySqlite(exportOntologySqlite(source));
    expect(back).toEqual(source);
  });
});
