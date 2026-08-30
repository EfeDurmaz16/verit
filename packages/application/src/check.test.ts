import { describe, expect, it } from "vitest";
import type { ProveOutcome, SuiteOutcome } from "@verit/ports";
import type { Understanding } from "@verit/domain";
import { behaviorProofCheck } from "./check";

/* A minimal Understanding. Individual tests override risks. */
const u = (risks: Understanding["risks"] = []): Understanding => ({
  what: "w",
  why: "y",
  how: "h",
  proof_refs: [],
  risks,
});

const passing: ProveOutcome = {
  command: "pnpm run test",
  source: "package.json#scripts.test",
  cwd: "/tmp/r",
  repo: "acme/pay",
  exitCode: 0,
  durationMs: 900,
  timedOut: false,
  logTail: "12 passed\n",
  log: "12 passed\n",
  startedAt: "2026-08-09T00:00:00Z",
  headSha: "abc1234",
  porcelainClean: true,
};

const changed = (spec: Record<string, readonly number[]>): Map<string, Set<number>> =>
  new Map(Object.entries(spec).map(([p, ls]) => [p, new Set(ls)]));

/* -------- INVARIANT 9: neutral passes required checks, so gating must not
   silently map an inconclusive proof to neutral. -------- */
describe("fail-on gating (INVARIANT 9)", () => {
  it("a no-proof run under fail-on=failure does NOT produce a passing conclusion", () => {
    // neutral is a PASS for a required check. Under gating it must be failure.
    const check = behaviorProofCheck({ understanding: u(), outcome: null, failOn: "failure" });
    expect(check.conclusion).not.toBe("neutral");
    expect(check.conclusion).not.toBe("success");
    expect(check.conclusion).toBe("failure");
  });

  it("default (fail-on=never) keeps today behavior: no proof stays neutral", () => {
    const check = behaviorProofCheck({ understanding: u(), outcome: null });
    expect(check.conclusion).toBe("neutral");
  });

  it("a real passing proof is success under gating, not forced to failure", () => {
    const check = behaviorProofCheck({ understanding: u(), outcome: passing, failOn: "failure" });
    expect(check.conclusion).toBe("success");
  });

  it("a refused proof under gating fails instead of passing as neutral", () => {
    const refused: ProveOutcome = {
      ...passing,
      exitCode: 1,
      logTail: "",
      log: "",
      porcelainClean: false,
      refused: "the working tree changed during analysis.",
    };
    const check = behaviorProofCheck({ understanding: u(), outcome: refused, failOn: "failure" });
    expect(check.conclusion).toBe("failure");
  });
});

/* -------- Annotation rules, enforced by construction. -------- */
describe("risk annotations", () => {
  const locatedReviewer = (file: string, line: number, severity?: "info" | "warn" | "high") =>
    ({ area: "auth", note: "unguarded path", source: "reviewer" as const, file, line, severity });

  it("zero risks: no annotations, and the body says zero", () => {
    const check = behaviorProofCheck({ understanding: u([]), outcome: passing });
    expect(check.annotations ?? []).toEqual([]);
    expect(check.summary).toContain("0 in total");
  });

  it("a located reviewer risk on a changed line becomes one annotation", () => {
    const check = behaviorProofCheck({
      understanding: u([locatedReviewer("src/a.ts", 42, "high")]),
      outcome: passing,
      changedLines: changed({ "src/a.ts": [10, 42, 43] }),
    });
    expect(check.annotations).toHaveLength(1);
    const a = check.annotations![0]!;
    expect(a.path).toBe("src/a.ts");
    expect(a.startLine).toBe(42);
    expect(a.endLine).toBe(42);
    expect(a.annotationLevel).toBe("failure"); // high -> failure
    expect(a.message).toContain("unguarded path");
  });

  it("drops an anchor that is not a changed line, never approximates it", () => {
    const check = behaviorProofCheck({
      understanding: u([locatedReviewer("src/a.ts", 99)]),
      outcome: passing,
      changedLines: changed({ "src/a.ts": [10, 42] }), // 99 is not changed
    });
    expect(check.annotations ?? []).toEqual([]);
    // the risk still shows as a bullet in the body: only the inline anchor drops
    expect(check.summary).toContain("unguarded path");
  });

  it("drops a deleted-file risk: it has no line in the PR head", () => {
    const check = behaviorProofCheck({
      understanding: u([locatedReviewer("gone.ts", 3)]),
      outcome: passing,
      changedLines: changed({ "src/a.ts": [1, 2, 3] }), // gone.ts absent
    });
    expect(check.annotations ?? []).toEqual([]);
  });

  it("keeps a unicode path verbatim on the annotation", () => {
    const p = "src/café/λ.ts";
    const check = behaviorProofCheck({
      understanding: u([locatedReviewer(p, 7, "warn")]),
      outcome: passing,
      changedLines: changed({ [p]: [7] }),
    });
    expect(check.annotations).toHaveLength(1);
    expect(check.annotations![0]!.path).toBe(p);
    expect(check.annotations![0]!.annotationLevel).toBe("warning");
  });

  it("caps at 25 annotations and states the overflow in the body", () => {
    const lines = Array.from({ length: 30 }, (_, i) => i + 1);
    const risks = lines.map((n) => locatedReviewer("src/a.ts", n, "warn"));
    const check = behaviorProofCheck({
      understanding: u(risks),
      outcome: passing,
      changedLines: changed({ "src/a.ts": lines }),
    });
    expect(check.annotations).toHaveLength(25);
    // 30 resolvable, 25 shown inline, 5 stated
    expect(check.summary).toContain("5 more");
  });

  it("only reviewer risks annotate: an author hint with a location does not", () => {
    const check = behaviorProofCheck({
      understanding: u([
        { area: "x", note: "author says so", source: "author", file: "src/a.ts", line: 5 },
      ]),
      outcome: passing,
      changedLines: changed({ "src/a.ts": [5] }),
    });
    expect(check.annotations ?? []).toEqual([]);
  });

  it("enforces the title and message caps by construction", () => {
    const bigNote = "x".repeat(70_000);
    const check = behaviorProofCheck({
      understanding: u([
        { area: "y".repeat(400), note: bigNote, source: "reviewer", file: "src/a.ts", line: 1, severity: "info" },
      ]),
      outcome: passing,
      changedLines: changed({ "src/a.ts": [1] }),
    });
    const a = check.annotations![0]!;
    expect(a.message.length).toBeLessThanOrEqual(65_536);
    expect((a.title ?? "").length).toBeLessThanOrEqual(255);
    expect(a.annotationLevel).toBe("notice"); // info -> notice
  });
});

/* -------- Reviewer findings are ADVISORY: they annotate, but the proof result
   plus fail-on drive the conclusion. A finding never turns a green or neutral
   proof into a failure. -------- */
describe("reviewer findings never change the Check conclusion", () => {
  const highFinding = (line: number) =>
    ({ area: "auth", note: "unguarded path", source: "reviewer" as const, file: "src/a.ts", line, severity: "high" as const });

  it("a passing proof with high-severity reviewer findings still concludes success", () => {
    const check = behaviorProofCheck({
      understanding: u([highFinding(1), highFinding(2), highFinding(3)]),
      outcome: passing,
      changedLines: changed({ "src/a.ts": [1, 2, 3] }),
    });
    expect(check.conclusion).toBe("success");
    // the findings still surface as annotations, they just do not gate.
    expect(check.annotations).toHaveLength(3);
    expect(check.annotations![0]!.annotationLevel).toBe("failure");
  });

  it("a neutral proof (no prove run) with findings stays neutral, never failure", () => {
    const check = behaviorProofCheck({
      understanding: u([highFinding(1)]),
      outcome: null,
      changedLines: changed({ "src/a.ts": [1] }),
    });
    expect(check.conclusion).toBe("neutral");
  });

  it("a refused proof with findings stays neutral, findings do not flip it to failure", () => {
    const refused: ProveOutcome = {
      ...passing,
      exitCode: 1,
      logTail: "",
      log: "",
      refused: "the working tree changed during analysis.",
    };
    const check = behaviorProofCheck({
      understanding: u([highFinding(1), highFinding(2)]),
      outcome: refused,
      changedLines: changed({ "src/a.ts": [1, 2] }),
    });
    expect(check.conclusion).toBe("neutral");
  });

  it("the proof is the driver: a failing proof fails whether or not findings exist", () => {
    const failing: ProveOutcome = { ...passing, exitCode: 1, logTail: "1 failed\n", log: "1 failed\n" };
    const withFindings = behaviorProofCheck({
      understanding: u([highFinding(1)]),
      outcome: failing,
      changedLines: changed({ "src/a.ts": [1] }),
    });
    const noFindings = behaviorProofCheck({ understanding: u([]), outcome: failing });
    expect(withFindings.conclusion).toBe("failure");
    expect(noFindings.conclusion).toBe("failure");
  });
});

/* -------- Body: capped bullets, details_url, no PROOF_PAGE_URL nag. -------- */
describe("Check body", () => {
  it("renders risks as capped bullets with an 'and N more' tail", () => {
    const risks = Array.from({ length: 14 }, (_, i) => ({
      area: `area${i}`,
      note: `note ${i}`,
      source: "reviewer" as const,
    }));
    const check = behaviorProofCheck({ understanding: u(risks), outcome: passing });
    expect(check.summary).toContain("14 in total");
    // capped bullets, then the remainder stated
    expect(check.summary).toContain("- ");
    expect(check.summary).toMatch(/and \d+ more/);
  });

  it("sets details_url to the proof page when present", () => {
    const check = behaviorProofCheck({
      understanding: u(),
      outcome: passing,
      proofPageUrl: "https://proof.example/r/acme/pay/runs/1",
    });
    expect(check.detailsUrl).toBe("https://proof.example/r/acme/pay/runs/1");
    expect(check.summary).toContain("[Full proof page]");
  });

  it("falls back details_url to the workflow run URL and drops the nag", () => {
    const check = behaviorProofCheck({
      understanding: u(),
      outcome: passing,
      workflowRunUrl: "https://github.com/acme/pay/actions/runs/7",
    });
    expect(check.detailsUrl).toBe("https://github.com/acme/pay/actions/runs/7");
    // the old "Set PROOF_PAGE_URL to link one" nag is gone from PR-facing output
    expect(check.summary).not.toContain("PROOF_PAGE_URL");
  });

  it("preserves newlines in how and truncates on a sentence boundary", () => {
    const how = "First step does A.\nSecond step does B. " + "tail ".repeat(200);
    const check = behaviorProofCheck({
      understanding: { ...u(), how },
      outcome: passing,
    });
    // the newline between the two steps survives
    expect(check.summary).toContain("First step does A.\nSecond step does B.");
    // the trailing filler is cut at a sentence end, not mid-word with an ellipsis run
    expect(check.summary).not.toContain("tail tail tail tail tail");
  });
});

/* -------- WS4: multi-suite rendering and probed manifests. -------- */
describe("multi-suite Check body", () => {
  const suite = (over: Partial<SuiteOutcome>): SuiteOutcome => ({
    command: "go test ./...",
    source: "go.mod",
    exitCode: 0,
    durationMs: 1200,
    timedOut: false,
    logTail: "ok\n",
    ...over,
  });

  const multi = (suites: SuiteOutcome[]): ProveOutcome => ({
    ...passing,
    command: `${suites.length} suites`,
    source: suites.map((s) => s.source).join(", "),
    exitCode: suites.some((s) => s.exitCode !== 0) ? 1 : 0,
    suites,
  });

  it("renders one section per suite and one combined conclusion", () => {
    const outcome = multi([
      suite({ command: "pytest -q", source: "pyproject.toml" }),
      suite({ command: "cargo test", source: "Cargo.toml" }),
      suite({ command: "pnpm run test", source: "package.json#scripts.test" }),
    ]);
    const check = behaviorProofCheck({ understanding: u(), outcome });
    expect(check.summary).toContain("pytest -q");
    expect(check.summary).toContain("cargo test");
    expect(check.summary).toContain("pnpm run test");
    // one conclusion for the whole run
    expect(check.conclusion).toBe("success");
    expect(check.summary).toContain("3 suites");
  });

  it("any suite failing makes the whole run fail", () => {
    const outcome = multi([
      suite({ command: "pytest -q", source: "pyproject.toml" }),
      suite({ command: "cargo test", source: "Cargo.toml", exitCode: 101 }),
    ]);
    const check = behaviorProofCheck({ understanding: u(), outcome });
    expect(check.conclusion).toBe("failure");
  });

  it("a skipped suite is stated and keeps the run off green", () => {
    const outcome = multi([
      suite({ command: "pytest -q", source: "pyproject.toml" }),
      suite({ command: "go test ./...", source: "go.mod", skipped: "go: command not found" }),
    ]);
    const check = behaviorProofCheck({ understanding: u(), outcome });
    expect(check.conclusion).toBe("neutral");
    expect(check.summary).toContain("go: command not found");
  });

  it("names every probed manifest when nothing ran", () => {
    const outcome: ProveOutcome = {
      ...passing,
      exitCode: 1,
      logTail: "",
      log: "",
      refused: "no test command found",
      probed: ["package.json (no test script)", "go.mod (absent)", "Makefile (absent)"],
    };
    const check = behaviorProofCheck({ understanding: u(), outcome });
    expect(check.conclusion).toBe("neutral");
    expect(check.summary).toContain("package.json (no test script)");
    expect(check.summary).toContain("go.mod (absent)");
    expect(check.title.toLowerCase()).toContain("no test command");
    // never dresses a no-command run up as a pass
    expect(check.summary.toLowerCase()).not.toContain("proof passed");
  });
});
