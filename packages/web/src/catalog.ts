/** Fixed proof catalog — Lattice-inspired; AI may only emit these types. */
export const PROOF_CATALOG = [
  "Workspace",
  "Section",
  "Understanding",
  "Summary",
  "ProofEvidence",
  "RisksList",
  "SuggestedPatch",
  "Meta",
  "ArchGraph",
  "Callout",
] as const;

export type ProofComponent = (typeof PROOF_CATALOG)[number];

export type Spec = {
  root: string;
  elements: Record<
    string,
    { type: string; props: Record<string, unknown>; children?: string[] }
  >;
};

/** SpecStream = ordered JSON-patch-like ops against a Spec (Lattice pattern). */
export type SpecStreamOp =
  | { op: "set"; id: string; type: string; props?: Record<string, unknown>; children?: string[] }
  | { op: "appendChild"; parent: string; child: string }
  | { op: "patchProps"; id: string; props: Record<string, unknown> };

export const applySpecStream = (spec: Spec, ops: readonly SpecStreamOp[]): Spec => {
  const next: Spec = {
    root: spec.root,
    elements: { ...spec.elements },
  };
  for (const op of ops) {
    if (op.op === "set") {
      next.elements[op.id] = {
        type: op.type,
        props: op.props ?? {},
        children: op.children,
      };
    } else if (op.op === "appendChild") {
      const parent = next.elements[op.parent];
      if (!parent) continue;
      next.elements[op.parent] = {
        ...parent,
        children: [...(parent.children ?? []), op.child],
      };
    } else if (op.op === "patchProps") {
      const el = next.elements[op.id];
      if (!el) continue;
      next.elements[op.id] = { ...el, props: { ...el.props, ...op.props } };
    }
  }
  return next;
};

export const catalogPrompt = (): string =>
  `You may only emit json-render elements of types: ${PROOF_CATALOG.join(", ")}. Root must be Workspace. Understanding must include what/why/how. RisksList must separate authorDeclared (hints) from reviewerFound. Do not invent proof — empty ProofEvidence is honest.`;

/** Author hints vs reviewer findings — never treat author list as an allowlist. */
export type RiskRow = { area: string; note: string; source?: string };
