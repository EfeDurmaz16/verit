import type { Understanding } from "@cyclops/domain";

/** Lattice-inspired proof catalog Spec (json-render shaped). */
export const understandingToProofSpec = (input: {
  understanding: Understanding;
  domain: string;
  focus?: string;
  reviewerRisks?: Understanding["risks"];
  archNodes?: Array<{ id: string; label: string }>;
  archEdges?: Array<{ from: string; to: string; kind?: string }>;
  suggestedPatch?: string;
}) => {
  const {
    understanding: u,
    domain,
    focus,
    reviewerRisks = [],
    archNodes = [],
    archEdges = [],
    suggestedPatch,
  } = input;

  const children = ["overview", "proof", "risks", "arch", "meta"];
  if (suggestedPatch) children.splice(4, 0, "patch");

  const elements: Record<
    string,
    { type: string; props: Record<string, unknown>; children?: string[] }
  > = {
    workspace: {
      type: "Workspace",
      props: {},
      children,
    },
    overview: {
      type: "Section",
      props: { id: "overview", title: "Understanding" },
      children: ["summary"],
    },
    summary: {
      type: "Understanding",
      props: {
        headline: u.what,
        what: u.what,
        why: u.why,
        how: u.how,
        body: `Why: ${u.why}\n\nHow: ${u.how}`,
      },
    },
    proof: {
      type: "Section",
      props: { id: "proof", title: "Proof" },
      children: ["proofList"],
    },
    proofList: {
      type: "ProofEvidence",
      // whole refs: an executed ref carries its verdict and log tail, and a
      // projection that drops them would render a failed proof as neutral
      props: { refs: u.proof_refs },
    },
    risks: {
      type: "Section",
      props: { id: "risks", title: "Risks" },
      children: ["riskList"],
    },
    riskList: {
      type: "RisksList",
      props: {
        authorDeclared: u.risks.filter((r) => r.source !== "reviewer"),
        reviewerFound: reviewerRisks.filter((r) => r.source === "reviewer"),
      },
    },
    arch: {
      type: "Section",
      props: { id: "arch", title: "Architecture" },
      children: ["archGraph"],
    },
    archGraph: {
      type: "ArchGraph",
      props: { nodes: archNodes, edges: archEdges },
    },
    meta: {
      type: "Section",
      props: { id: "meta", title: "Meta" },
      children: ["metaRow"],
    },
    metaRow: {
      type: "Meta",
      props: {
        domain,
        focus: focus ?? "none",
        outOfScope: u.out_of_scope ?? [],
      },
    },
  };

  if (suggestedPatch) {
    elements.patch = {
      type: "Section",
      props: { id: "patch", title: "Suggested patch" },
      children: ["patchBody"],
    };
    elements.patchBody = {
      type: "SuggestedPatch",
      props: { diff: suggestedPatch },
    };
  }

  return { root: "workspace", elements };
};
