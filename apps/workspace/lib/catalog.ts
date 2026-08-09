import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/* The component catalog — the ONLY vocabulary the model can render with.
   catalog.prompt() turns this into the system prompt; the renderer refuses
   anything not registered here. */

const risk = z.number().int().min(0).max(3).describe("0 none · 1 low · 2 medium · 3 high");

const fileEntry = z.object({
  path: z.string().describe("exact path from the PR diff"),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  risk: risk.default(0),
  note: z.string().optional().describe("one line: what changed and why it matters"),
  tags: z.array(z.string()).default([]).describe("e.g. security, protocol, api, test"),
});

const evidence = z.object({
  file: z.string().describe("exact path from the diff"),
  lines: z.string().optional().describe('e.g. "41-58"'),
  excerpt: z.string().optional().describe("verbatim code from the diff, never invented"),
  note: z.string().optional().describe("why this evidence supports the claim"),
});

export const catalog = defineCatalog(schema, {
  components: {
    Workspace: {
      props: z.object({}),
      slots: ["default"],
      description:
        "The root container. The spec root MUST be a single Workspace whose children are Sections.",
    },
    Section: {
      props: z.object({
        id: z.string().describe("kebab-case anchor, e.g. overview, risks, changed-files"),
        title: z.string(),
        hint: z.string().optional().describe("small right-aligned annotation"),
      }),
      slots: ["default"],
      description:
        "Top-level work surface. Every visible area of the workspace is a Section; the left rail is derived from them in order.",
    },
    Columns: {
      props: z.object({ split: z.enum(["1:1", "2:1", "1:2"]).default("1:1") }),
      slots: ["default"],
      description: "Two-column layout for pairing related surfaces. Give it exactly two children.",
    },
    Text: {
      props: z.object({
        content: z.string(),
        tone: z.enum(["default", "muted"]).default("default"),
      }),
      description: "Plain paragraph.",
    },
    Summary: {
      props: z.object({
        headline: z.string().describe("one sentence, the hard part first"),
        body: z.string().describe("4-6 sentences: what the PR really does, where risk concentrates, what blocks merge"),
      }),
      description: "Executive summary of the PR. Exactly one, at the top.",
    },
    Callout: {
      props: z.object({
        text: z.string(),
        tone: z.enum(["info", "warn", "danger", "ok"]).default("info"),
      }),
      description: "Single-line emphasized note, e.g. the release blocker.",
    },
    MetricRow: {
      props: z.object({
        metrics: z.array(
          z.object({
            label: z.string(),
            value: z.string(),
            tone: z.enum(["default", "danger", "ok"]).default("default"),
          }),
        ),
      }),
      description: "Compact stat strip (4-6 metrics).",
    },
    ReviewPath: {
      props: z.object({
        steps: z.array(
          z.object({
            title: z.string(),
            why: z.string().describe("why this order; dependency-aware"),
            files: z.array(z.string()).default([]),
            minutes: z.number().default(10),
            risk: risk.default(1),
          }),
        ),
      }),
      description: "Ordered review plan, 4-7 steps. Read contracts/specs before implementations.",
    },
    RiskCluster: {
      props: z.object({
        title: z.string(),
        level: risk,
        summary: z.string(),
        files: z.array(z.string()).default([]),
      }),
      description: "One cluster of correlated risk. Stack 3-5 inside a risks Section.",
    },
    Insight: {
      props: z.object({
        kind: z.enum(["security", "compat", "correctness", "perf", "design"]),
        title: z.string(),
        body: z.string(),
        confidence: z.number().min(0).max(1).describe("honest; <0.5 means worth checking"),
        reasoning: z.string().optional().describe("why you believe this"),
        evidence: z.array(evidence).default([]),
        files: z.array(z.string()).default([]),
      }),
      description:
        "A sharp finding with verbatim evidence. Emit each insight as its own element the moment you derive it.",
    },
    FileGroup: {
      props: z.object({
        title: z.string().describe("subsystem name"),
        files: z.array(fileEntry),
      }),
      description: "Changed files for one subsystem. Group every file of the PR into FileGroups.",
    },
    CIStatus: {
      props: z.object({
        checks: z.array(
          z.object({
            name: z.string(),
            status: z.enum(["pass", "fail", "running", "skipped"]),
            note: z.string().optional().describe("for failures: WHY it fails, from the logs"),
            url: z.string().optional(),
          }),
        ),
      }),
      description: "CI check results with failure explanations.",
    },
    LogTail: {
      props: z.object({ lines: z.array(z.string()) }),
      description: "Monospace log excerpt (e.g. the failing test output).",
    },
    CodePreview: {
      props: z.object({
        file: z.string(),
        header: z.string().optional().describe('hunk header, e.g. "@@ -41,9 +41,32 @@"'),
        lines: z.array(
          z.object({
            kind: z.enum(["ctx", "add", "del"]),
            no: z.number().nullable().default(null),
            text: z.string(),
          }),
        ),
      }),
      description: "A key diff hunk, verbatim from the PR.",
    },
    Discussion: {
      props: z.object({
        themes: z.array(
          z.object({
            title: z.string(),
            stance: z.string().describe("Converging | Fix requested | Resolved | Contested"),
            body: z.string().describe("synthesis of the real comment threads"),
          }),
        ),
      }),
      description: "Synthesis of review discussion into themes. Skip if there are no comments.",
    },
    CompatMatrix: {
      props: z.object({
        title: z.string().default("Compatibility"),
        columns: z.array(z.string()),
        rows: z.array(
          z.object({
            capability: z.string(),
            cells: z.array(
              z.object({
                status: z.enum(["done", "partial", "missing", "na"]),
                note: z.string().optional(),
              }),
            ),
          }),
        ),
      }),
      description:
        "Capability × implementation matrix. Only when the PR contains parallel implementations of one contract.",
    },
    ArchGraph: {
      props: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            kind: z.enum(["spec", "core", "sdk", "infra", "ui", "api", "db", "worker"]),
            layer: z.number().int().min(0).max(4).describe("0 = contract/entry, 4 = leaf"),
            changed: z.boolean().default(false),
            detail: z.string().optional(),
            files: z.array(z.string()).default([]),
          }),
        ),
        edges: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            changed: z.boolean().optional(),
          }),
        ),
      }),
      description: "Subsystem dependency graph this PR touches (5-10 nodes).",
    },
    Timeline: {
      props: z.object({
        events: z.array(
          z.object({
            time: z.string(),
            actor: z.string(),
            text: z.string(),
            kind: z.enum(["commit", "review", "ci", "system"]).default("system"),
          }),
        ),
      }),
      description: "Chronology of the PR: commits, reviews, CI runs.",
    },
    NextSteps: {
      props: z.object({
        items: z.array(
          z.object({
            title: z.string().describe("verdict-style action"),
            detail: z.string(),
            kind: z.enum(["blocking", "strong", "normal"]).default("normal"),
          }),
        ),
      }),
      description: "2-4 recommendations for the reviewer, blocking first.",
    },
    Status: {
      props: z.object({ text: z.string() }),
      description: "One-line progress note while analysis is still running. Replace it as you go.",
    },
  },
  actions: {},
});

export type WorkspaceCatalog = typeof catalog;
