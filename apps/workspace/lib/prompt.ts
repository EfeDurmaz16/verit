import { OUTPUT_STYLE, UNDERSTANDING_JSON_SHAPE } from "@cyclops/domain";
import { catalog } from "./catalog";
import { BLOCKS_FILE } from "./lane";
import type { PRMeta } from "./schema";
import { SECTION, UNDERSTANDING_FILE } from "./understanding";

/* Bump when prompt or protocol semantics change. It is part of the session key. */
export const PROMPT_VERSION = "v6";

const PROTOCOL = `
STREAMING PROTOCOL. The reviewer watches the workspace assemble in real time:
Append SpecStream lines to ./${BLOCKS_FILE} as you work (printf '%s\\n' '<json>' >> ${BLOCKS_FILE}).
Each line is ONE minified RFC 6902 JSON patch against the spec:
  {"op":"add","path":"/elements/<key>","value":{"type":"<Component>","props":{...},"children":[]}}
  {"op":"add","path":"/elements/<section>/children/-","value":"<key>"}   attach your element to a section
  {"op":"replace","path":"/elements/<key>","value":{...}}                swap a whole element
  {"op":"replace","path":"/elements/<key>/props/<prop>","value":...}     tweak one prop

Hard rules:
- One patch per line, minified. Keep every line under 3000 characters. Split large content into several elements instead of one giant value.
- Add an element BEFORE attaching its key to a section's children.
- NEVER modify /root or /elements/ws.
- Every file path, line number, and code excerpt must come verbatim from the diff. Never invent.
- EMIT AS YOU GO. A rough element now plus a replace later beats a perfect element at the end.
`;

/* The lane fills exactly the Understanding surfaces. Keys are fixed so the
   server can overwrite each one with the schema-validated value at the end. */
const SURFACES = `
YOUR SECTIONS AND THE ELEMENT KEY FOR EACH. Use these keys exactly:
- ${SECTION.understanding} -> key "u-what" (Summary: headline = what changed, body = why it changed)
                          -> key "u-how"  (Text: how it is implemented)
- ${SECTION.proof}         -> key "u-proof" (ProofEvidence: how a human verifies the behaviour)
- ${SECTION.risks}         -> key "u-risks" (RisksList: what you found vs what the author declared)
- ${SECTION.scope}         -> key "u-scope" (Text: what this PR deliberately does not do; omit if nothing)

You may add extra evidence elements with the key prefix "e-" (Insight, CodePreview, Callout)
and attach them to ${SECTION.proof} or ${SECTION.risks}. Nothing else.
`;

const CONTRACT = `
OUTPUT CONTRACT. This is what the run is judged on.
When your analysis is complete, write ./${UNDERSTANDING_FILE} (one JSON object, not JSONL):
${UNDERSTANDING_JSON_SHAPE}
- Write the file exactly once, at the end, after the workspace already reflects your analysis.
`;

export function understandPrompt(pr: PRMeta): string {
  return `You are the analysis lane behind cyclops, a behaviour-proof review workspace for ${pr.url} ("${pr.title}", ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}).

Your job is to produce the Understanding of this pull request: what it changes, why, how, how a human can verify the behaviour, and where the risk is.

ALL DATA IS ALREADY ON DISK in your working directory. Do NOT run gh to fetch it:
- ./diff.patch     the full unified diff
- ./pr.json        title, description, branches, commit list, reviews
- ./comments.json  inline review comments (may be empty)
- ./ci.json        check names and status
- ./ci-fail.log    tail of the failing CI logs (only if something failed)
Read them with sed/rg/cat. The gh CLI is available only if you genuinely need something beyond these.

The workspace shell already exists. The section slots below are pre-created and empty.

${catalog.prompt()}

${PROTOCOL}
${SURFACES}
${OUTPUT_STYLE}

Work order. The first step must produce patches within your first minute:
1. Read pr.json and the first ~300 lines of diff.patch. IMMEDIATELY emit a draft "u-what" and replace status-el's text with what you are doing.
2. Read the rest of diff.patch (rg for the load-bearing parts), plus comments.json and ci-fail.log. Refine "u-what" and emit "u-how".
3. Emit "u-proof" as soon as you know how the behaviour can be checked, then "u-risks", then "u-scope".
4. Replace status-el's text with a one-line completion note.
5. Write ./${UNDERSTANDING_FILE}.

${CONTRACT}

When done, reply with exactly: done`;
}

export function commandPrompt(command: string): string {
  return `The reviewer typed this into the workspace command bar: "${command}"

The PR data files (diff.patch, pr.json, comments.json, ci.json, ci-fail.log) are still in your working directory.

Respond by appending lines to ./${BLOCKS_FILE} (same SpecStream protocol):
1. Stream your answer as you form it: append {"answer":"<sentence or two>"} lines progressively (2-4 chunks). Be concrete and cite exact file paths.
2. If the command changes what the workspace should emphasize, patch it: you MAY reorder /elements/ws/children (move ops), add a new Section (add element with key prefix "q-", then append its key to /elements/ws/children), or replace existing elements with refocused versions.
3. New analysis must come with verbatim evidence. Never invent paths or code.
4. Keep untouched elements untouched.
5. Do NOT rewrite ${UNDERSTANDING_FILE}. That artifact belongs to the analysis run.
${OUTPUT_STYLE}
When done, reply with exactly: done`;
}
