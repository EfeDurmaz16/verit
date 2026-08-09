import { catalog } from "./catalog";
import { BLOCKS_FILE } from "./codex";
import type { PRMeta } from "./schema";

/* Bump when prompt/protocol semantics change — part of the cache key. */
export const PROMPT_VERSION = "v4";

const PROTOCOL = (file: string) => `
STREAMING PROTOCOL — the user watches the workspace assemble in real time:
Append SpecStream lines to ./${file} as you work (printf '%s\\n' '<json>' >> ${file}).
Write ONLY to ./${file} — never to any other lane's blocks file.
Each line is ONE minified RFC 6902 JSON patch against the spec:
  {"op":"add","path":"/elements/<key>","value":{"type":"<Component>","props":{...},"children":[]}}
  {"op":"add","path":"/elements/<section>/children/-","value":"<key>"}   — attach your element to a section
  {"op":"replace","path":"/elements/<key>","value":{...}}                — swap a whole element
  {"op":"replace","path":"/elements/<key>/props/<prop>","value":...}     — tweak one prop

Hard rules:
- One patch per line, minified. Keep every line under 3000 characters — split large content into multiple elements rather than one giant value.
- Add an element BEFORE attaching its key to a section's children.
- Only touch the sections assigned to you. NEVER modify /root or /elements/ws.
- Every file path, line number, and code excerpt must come verbatim from the diff. Never invent.
- EMIT AS YOU GO. A rough element now + a replace later beats a perfect element at the end.
`;

export const laneFile = (label: string) => `blocks-${label}.ndjson`;

function preamble(pr: PRMeta, file: string): string {
  return `You are one analysis lane behind "Lattice", a code-review workspace for ${pr.url} ("${pr.title}", ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}).

ALL DATA IS ALREADY ON DISK in your working directory — do NOT run gh to fetch it:
- ./diff.patch     — the full unified diff
- ./pr.json        — title, description, branches, commit list, reviews
- ./comments.json  — inline review comments (may be empty)
- ./ci.json        — check names + status
- ./ci-fail.log    — tail of the failing CI logs (only if something failed)
Read them with sed/rg/cat. The gh CLI is available only if you genuinely need something beyond these.

The workspace shell already exists. Section slots are pre-created; you fill YOUR sections only.

${catalog.prompt()}

${PROTOCOL(file)}`;
}

/* Three parallel lanes over disjoint section slots. Key prefixes prevent
   collisions; fixed ws order prevents layout races. */
export function lanePrompts(pr: PRMeta): { label: string; prompt: string; lead: boolean; tier: "smart" | "fast" }[] {
  return [
    {
      label: "lead",
      lead: true,
      tier: "smart",
      prompt: `${preamble(pr, laneFile("lead"))}

YOUR SECTIONS: sec-overview, sec-review-order, sec-next-steps. Element key prefix: "a-".

Work order — the first two steps must produce patches within your first minute:
1. Read pr.json and the first ~300 lines of diff.patch. IMMEDIATELY emit a draft Summary into sec-overview (headline + best-current-understanding body) and replace status-el's text with what you're doing.
2. Skim the rest of diff.patch (rg for the load-bearing parts). Refine the Summary via replace; add a Callout to sec-overview if there is a genuine merge blocker (CI failure cause from ci-fail.log, unresolved P1 thread, etc.).
3. Emit a ReviewPath (4-7 dependency-aware steps, contracts before implementations) into sec-review-order.
4. Emit NextSteps (2-4 verdict-style items, blocking first) into sec-next-steps.
5. Finish by replacing status-el text with a one-line completion note for your lane.

When done, reply with exactly: done`,
    },
    {
      label: "insight",
      lead: false,
      tier: "smart",
      prompt: `${preamble(pr, laneFile("insight"))}

YOUR SECTIONS: sec-risks, sec-insights. Element key prefix: "b-".

Work order:
1. Read diff.patch fully (in parts), plus comments.json and ci-fail.log.
2. INTERLEAVE, do not batch: the moment you derive an Insight, emit it; the moment a cluster of correlated risk becomes clear, emit that RiskCluster into sec-risks right then — even if you are only halfway through the diff. Aim for 4-8 Insights (security and correctness first, honest confidence, verbatim evidence with real line numbers) and 3-5 RiskClusters. A RiskCluster may be refined later via replace; never held back.
3. Add ONE CodePreview of the single most load-bearing hunk to sec-insights.

When done, reply with exactly: done`,
    },
    {
      label: "structure",
      lead: false,
      tier: "fast",
      prompt: `${preamble(pr, laneFile("structure"))}

YOUR SECTIONS: sec-architecture, sec-discussion, plus enriching the existing FileGroups in sec-files. Element key prefix: "c-".

Work order:
1. Skim diff.patch (per file) and pr.json.
2. FIRST, within your first minute: emit a draft ArchGraph (5-10 nodes, layer 0 = contract/entry) into sec-architecture from that skim. You may replace it with a refined version at the end.
3. Then REPLACE each existing FileGroup element (keys start with "fg-") with proper subsystem grouping: per-file risk 0-3, one-line note (what changed and why it matters), tags (security/protocol/api/test/docs/infra). Keep the same element keys; update sec-files' hint prop. Emit group-by-group as you finish each.
4. If comments.json has real threads, emit a Discussion synthesis into sec-discussion. Otherwise leave it empty.

When done, reply with exactly: done`,
    },
  ];
}

export function commandPrompt(command: string): string {
  return `The reviewer typed this into the workspace command bar: "${command}"

The PR data files (diff.patch, pr.json, comments.json, ci.json, ci-fail.log) are still in your working directory.

Respond by appending lines to ./${BLOCKS_FILE} (same SpecStream protocol):
1. Stream your answer as you form it: append {"answer":"<sentence or two>"} lines progressively (2-4 chunks). Concrete, cite exact file paths.
2. If the command changes what the workspace should emphasize, patch it: you MAY reorder /elements/ws/children (move ops), add a new Section (add element with key prefix "q-", then append its key to /elements/ws/children), or replace existing elements with refocused versions.
3. New analysis must come with verbatim evidence. Never invent paths or code.
4. Keep untouched elements untouched.

When done, reply with exactly: done`;
}
