import { Effect } from "effect";
import type { ReviewContext, ReviewDomain, Understanding } from "@cyclops/domain";
import type { ClassifierPort, HarnessPort, ParserPort, ProofRenderPort, VcsPort } from "@cyclops/ports";
import { StoreError } from "@cyclops/ports";
import { understandingToProofSpec } from "@cyclops/application";

const pathDomainHints: Array<{ re: RegExp; domain: ReviewDomain }> = [
  { re: /auth|permission|secret/i, domain: "SECURITY" },
  { re: /pay|stripe|billing/i, domain: "PAYMENTS" },
  { re: /solana|wallet|crypto|chain/i, domain: "CRYPTO" },
  { re: /\.tsx$|components\//i, domain: "FRONTEND" },
  { re: /docker|k8s|terraform/i, domain: "INFRASTRUCTURE" },
  { re: /\.yml$|workflow|ci/i, domain: "DEVOPS" },
  { re: /sql|migration|schema/i, domain: "DATABASE" },
];

export const makeHeuristicClassifier = (): ClassifierPort => ({
  classify: ({ title, body, paths }) =>
    Effect.sync(() => {
      const blob = `${title}\n${body}\n${paths.join("\n")}`;
      for (const h of pathDomainHints) {
        if (h.re.test(blob)) {
          return { domain: h.domain, focus: undefined, confidence: 0.6 };
        }
      }
      return { domain: "GENERAL" as const, confidence: 0.3 };
    }),
});

export const makeStubHarness = (): HarnessPort => ({
  runUnderstand: ({ title, body, paths, diff, context, role }) =>
    Effect.sync(() => {
      const pathPreview = paths.slice(0, 8).join(", ") || "(no paths)";
      const wikiBit =
        context.wiki_hits.length > 0
          ? context.wiki_hits
              .slice(0, 3)
              .map((h) => h.title)
              .join("; ")
          : "none";
      const understanding: Understanding = {
        what: title.trim() || `Review (${role}): untitled change`,
        why:
          (body.trim().split(/\n\n/)[0] ?? "").trim().slice(0, 280) ||
          `Change in ${context.domain}${context.focus ? `×${context.focus}` : ""} (stub harness; set CYCLOPS_PI_BIN for live Pi).`,
        how: `Touched ${paths.length} path(s): ${pathPreview}. Diff ${diff.length} chars. Wiki: ${wikiBit}. PR-graph neighbors: ${context.pr_graph.length}.`,
        proof_refs: [
          { kind: "command", label: "diff-stats", value: `chars=${diff.length}; paths=${paths.length}` },
          ...(paths[0]
            ? [{ kind: "url" as const, label: "first-path", value: paths[0] }]
            : []),
        ],
        out_of_scope: ["Live model reasoning (Pi binary not invoked in this stub path)"],
        risks: [
          {
            area: "stub",
            note: "Deterministic stub Understanding. Not model-authored proof.",
            source: "reviewer",
          },
        ],
      };
      return understanding;
    }),
});

export const makeProofRender = (): ProofRenderPort => ({
  toSpec: ({ understanding, context, risksReviewer, archNodes, archEdges, suggestedPatch }) =>
    understandingToProofSpec({
      understanding: {
        ...understanding,
        risks: [
          ...understanding.risks,
          ...risksReviewer.filter(
            (r) => !understanding.risks.some((x) => x.area === r.area && x.note === r.note),
          ),
        ],
      },
      domain: context.domain,
      focus: context.focus,
      reviewerRisks: risksReviewer,
      archNodes,
      archEdges,
      suggestedPatch,
    }),
});

/** Regex/tree-lite symbol extract, upgraded by treesitter adapter when available. */
export const makeRegexParser = (): ParserPort => ({
  extractSymbols: (path, source) =>
    Effect.sync(() => {
      const out: Array<{ name: string; kind: string; startLine: number; endLine: number }> = [];
      const lines = source.split(/\r?\n/);
      const re =
        path.endsWith(".go")
          ? /^func\s+(\w+)/
          : /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:const|class|type|interface)\s+(\w+)/;
      lines.forEach((line, i) => {
        const m = re.exec(line);
        const name = m?.[1] ?? m?.[2];
        if (name) out.push({ name, kind: "symbol", startLine: i + 1, endLine: i + 1 });
      });
      return out;
    }),
});

export const makeFakeVcs = (): VcsPort => ({
  fetchPullRequest: (owner, repo, number) =>
    Effect.succeed({
      pr: {
        id: `pr:${owner}/${repo}#${number}`,
        repoId: `repo:${owner}/${repo}`,
        number,
        title: `Fake PR ${number}`,
        body: "dogfood",
        author: "dogfood-bot",
        baseRef: "main",
        headRef: "feature",
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
      },
      closingNumbers: [],
      changedPaths: ["README.md"],
      patch: "diff --git a/README.md b/README.md\n+dogfood\n",
    }),
});
