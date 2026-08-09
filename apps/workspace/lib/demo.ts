import * as mock from "./data";

/* Demo mode: the mock PR compiled through the exact same SpecStream pipeline
   the live agent uses. buildDemoLines() yields patch lines in narrative order;
   buildDemoSpec(focus) yields target specs for instant command reorganization. */

export type Focus = "all" | "security" | "protocol" | "risk";

type El = { type: string; props: Record<string, unknown>; children: string[] };
type Spec = { root: string; elements: Record<string, El> };

const SUMMARIES: Record<Focus, { headline: string; body: string }> = {
  all: {
    headline: "A protocol-version bump implemented three times in parallel.",
    body: "This PR defines the v0.9 signed envelope in the spec, implements it in the TS core, and ports it to the Rust and Python SDKs with a shared conformance suite. The structure is sound and review activity is converging. One release blocker: Python's canonicalization is hand-rolled and byte-diverges from the other SDKs on two float vectors, which is why both failing CI jobs fail.",
  },
  security: {
    headline: "Three security surfaces: signature path, replay window, authorization.",
    body: "Signature construction and verification look correct and are conformance-tested. The two open exposures are the per-process nonce cache (replay window across instances) and Python's fnmatch scope matcher, which accepts patterns the spec never defined. Neither is caught by CI today.",
  },
  protocol: {
    headline: "Two spec documents drive every other change in this PR.",
    body: "spec/envelope.md defines the canonical payload and signature; spec/capabilities.md defines the scope grammar. The compatibility matrix shows where each SDK actually stands against those documents. Python is behind on canonicalization (the CI failures) and wider than spec on scope matching (invisible to CI).",
  },
  risk: {
    headline: "Risk concentrates in the three parallel implementations staying identical.",
    body: "Everything dangerous in this PR is a divergence risk: canonical bytes, scope semantics, skew handling. The conformance suite is the control for the first; the second and third currently rely on review.",
  },
};

function fileTags(f: (typeof mock.files)[number]): string[] {
  const t: string[] = [];
  if (f.security) t.push("security");
  if (f.protocol) t.push("protocol");
  return t;
}

const yToLayer = (y: number) => (y < 20 ? 0 : y < 50 ? 1 : y < 80 ? 2 : 3);

export function buildDemoSpec(focus: Focus): Spec {
  const elements: Record<string, El> = {};
  const el = (key: string, type: string, props: Record<string, unknown>, children: string[] = []) => {
    elements[key] = { type, props, children };
    return key;
  };
  const sections: string[] = [];

  // overview
  el("summary-el", "Summary", SUMMARIES[focus]);
  el("blocker-el", "Callout", {
    tone: "danger",
    text: "Merge blocker: Python canonicalization byte-diverges from TS/Rust on conformance vectors 31 and 34.",
  });
  sections.push(el("sec-overview", "Section", { id: "overview", title: "Overview" }, ["summary-el", "blocker-el"]));

  const fileList =
    focus === "security"
      ? mock.files.filter((f) => f.security)
      : focus === "protocol"
        ? mock.files.filter((f) => f.protocol)
        : focus === "risk"
          ? mock.files.filter((f) => f.risk >= 2)
          : mock.files;

  const riskEls = mock.riskClusters
    .filter((r) => (focus === "security" || focus === "risk" ? r.level >= 2 : true))
    .map((r, i) =>
      el(`risk-${i}`, "RiskCluster", {
        title: r.title,
        level: r.level,
        summary: r.summary,
        files: r.files,
      }),
    );
  const secRisks = el("sec-risks", "Section", { id: "risks", title: "Risk clusters" }, riskEls);

  const insightList =
    focus === "security"
      ? mock.insights.filter((i) => ["security", "correctness"].includes(i.kind))
      : focus === "protocol"
        ? mock.insights.filter((i) => ["compat", "design"].includes(i.kind))
        : mock.insights;
  const insightEls = insightList.map((ins, i) =>
    el(`ins-${i}`, "Insight", {
      kind: ins.kind,
      title: ins.title,
      body: ins.body,
      confidence: ins.confidence,
      reasoning: ins.reasoning,
      evidence: ins.evidence.map(({ file, lines, excerpt, note }) => ({ file, lines, excerpt, note })),
      files: ins.files,
    }),
  );
  const hunkFile = mock.files.find((f) => f.path.endsWith("verify.ts"));
  if (hunkFile?.hunk) {
    insightEls.push(
      el("hunk-el", "CodePreview", {
        file: hunkFile.path,
        header: hunkFile.hunk.header,
        lines: hunkFile.hunk.lines,
      }),
    );
  }
  const secInsights = el(
    "sec-insights",
    "Section",
    { id: "insights", title: "Generated insights", hint: "click to inspect evidence" },
    insightEls,
  );

  const steps =
    focus === "security" || focus === "risk"
      ? mock.reviewSteps.filter((s) => s.risk >= 2)
      : focus === "protocol"
        ? [mock.reviewSteps[0], mock.reviewSteps[1], mock.reviewSteps[3], mock.reviewSteps[5]]
        : mock.reviewSteps;
  el("path-el", "ReviewPath", {
    steps: steps.map(({ title, why, files, minutes, risk }) => ({ title, why, files, minutes, risk })),
  });
  const secPath = el(
    "sec-review-order",
    "Section",
    {
      id: "review-order",
      title: "Suggested review order",
      hint: `~${steps.reduce((a, s) => a + s.minutes, 0)} min total`,
    },
    ["path-el"],
  );

  el("arch-el", "ArchGraph", {
    nodes: mock.archNodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      layer: yToLayer(n.y),
      changed: n.changed,
      detail: n.detail,
      files: n.files,
    })),
    edges: mock.archEdges,
  });
  const secArch = el(
    "sec-architecture",
    "Section",
    { id: "architecture", title: "Architecture impact", hint: "changed subsystems" },
    ["arch-el"],
  );

  const groups = [...new Set(fileList.map((f) => f.group))];
  const fgEls = groups.map((g, i) =>
    el(`fg-${i}`, "FileGroup", {
      title: g,
      files: fileList
        .filter((f) => f.group === g)
        .map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          risk: f.risk,
          note: f.summary,
          tags: fileTags(f),
        })),
    }),
  );
  const secFiles = el(
    "sec-files",
    "Section",
    {
      id: "changed-files",
      title: "Changed files",
      hint: focus === "all" ? "grouped by subsystem" : `${focus}-relevant only`,
    },
    fgEls,
  );

  el("ci-el", "CIStatus", {
    checks: mock.checks.map((c) => ({ name: c.name, status: c.status, note: c.detail })),
  });
  const failLog = mock.checks.find((c) => c.logTail);
  const ciChildren = ["ci-el"];
  if (failLog?.logTail) {
    el("ci-log", "LogTail", { lines: failLog.logTail });
    ciChildren.push("ci-log");
  }
  const secCI = el(
    "sec-ci",
    "Section",
    {
      id: "ci",
      title: "CI",
      hint: `${mock.checks.filter((c) => c.status === "pass").length}/${mock.checks.length} passing`,
    },
    ciChildren,
  );

  el("disc-el", "Discussion", {
    themes: mock.discussionThemes.map(({ title, stance, body }) => ({ title, stance, body })),
  });
  const secDisc = el(
    "sec-discussion",
    "Section",
    { id: "discussion", title: "Discussion synthesis", hint: "6 comments · 4 themes" },
    ["disc-el"],
  );

  el("compat-el", "CompatMatrix", {
    title: "Cross-SDK compatibility",
    columns: mock.compatSDKs,
    rows: mock.compatRows.map((r) => ({
      capability: r.capability,
      cells: mock.compatSDKs.map((s) => r.cells[s]),
    })),
  });
  const secCompat = el(
    "sec-compatibility",
    "Section",
    { id: "compatibility", title: "Cross-SDK compatibility", hint: "capability × implementation" },
    ["compat-el"],
  );

  el("tl-el", "Timeline", { events: mock.timeline });
  const secTl = el("sec-timeline", "Section", { id: "timeline", title: "Timeline", hint: "today" }, ["tl-el"]);

  el("next-el", "NextSteps", {
    items: mock.suggestedNextSteps.map(({ title, detail, kind }) => ({ title, detail, kind })),
  });
  const secNext = el("sec-next-steps", "Section", { id: "next-steps", title: "Suggested next step" }, ["next-el"]);

  const order: Record<Focus, string[]> = {
    all: [sections[0], secPath, secRisks, secArch, secFiles, secCI, secInsights, secDisc, secCompat, secTl, secNext],
    security: [sections[0], secRisks, secInsights, secFiles, secPath, secArch, secDisc, secCI, secTl, secNext],
    protocol: [sections[0], secCompat, secFiles, secPath, secInsights, secArch, secRisks, secDisc, secCI, secTl, secNext],
    risk: [sections[0], secRisks, secFiles, secInsights, secPath, secArch, secCI, secDisc, secTl, secNext],
  };

  el("ws", "Workspace", {}, order[focus]);
  return { root: "ws", elements };
}

/* Streaming order for the initial demo load: shell first (files/ci/timeline),
   then understanding layers — mirrors what the live agent does. */
export function buildDemoLines(): string[] {
  const spec = buildDemoSpec("all");
  const add = (key: string) =>
    JSON.stringify({ op: "add", path: `/elements/${key}`, value: spec.elements[key] });

  const narrative: string[] = [];
  const emitSection = (secKey: string) => {
    for (const child of spec.elements[secKey].children) narrative.push(add(child));
    narrative.push(add(secKey));
    narrative.push(
      JSON.stringify({ op: "add", path: "/elements/ws/children/-", value: secKey }),
    );
  };

  narrative.push(JSON.stringify({ op: "add", path: "/elements/ws", value: { ...spec.elements.ws, children: [] } }));
  narrative.push(JSON.stringify({ op: "add", path: "/root", value: "ws" }));

  // shell-like first paint, then analysis layers in the ws order
  const wsOrder = spec.elements.ws.children;
  const firstWave = ["sec-files", "sec-ci", "sec-timeline"];
  for (const s of firstWave) emitSection(s);
  for (const s of wsOrder) if (!firstWave.includes(s)) emitSection(s);

  // final reorder to the intended layout
  narrative.push(
    JSON.stringify({ op: "replace", path: "/elements/ws/children", value: wsOrder }),
  );
  return narrative;
}
