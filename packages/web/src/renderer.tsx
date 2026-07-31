import React from "react";
import type { Spec } from "./catalog.js";

const el = (spec: Spec, id: string): React.ReactNode => {
  const node = spec.elements[id];
  if (!node) return null;
  const kids = (node.children ?? []).map((c: string) => (
    <React.Fragment key={c}>{el(spec, c)}</React.Fragment>
  ));
  switch (node.type) {
    case "Workspace":
      return <div className="workspace">{kids}</div>;
    case "Section":
      return (
        <section className="section">
          <h2>{String(node.props.title ?? "")}</h2>
          {kids}
        </section>
      );
    case "Understanding":
    case "Summary":
      return (
        <div className="summary">
          <h1>{String(node.props.headline ?? node.props.what ?? "")}</h1>
          <p style={{ whiteSpace: "pre-wrap" }}>
            {String(node.props.body ?? `Why: ${node.props.why ?? ""}\n\nHow: ${node.props.how ?? ""}`)}
          </p>
        </div>
      );
    case "ProofEvidence": {
      const refs =
        (node.props.refs as Array<{ kind: string; label: string; value: string }>) ?? [];
      return (
        <ul>
          {refs.map((r, i) => (
            <li key={i}>
              <strong>{r.kind}</strong> {r.label}: <code>{r.value}</code>
            </li>
          ))}
        </ul>
      );
    }
    case "RisksList": {
      const author =
        (node.props.authorDeclared as Array<{ area: string; note: string }>) ?? [];
      const reviewer =
        (node.props.reviewerFound as Array<{ area: string; note: string }>) ?? [];
      return (
        <div>
          <h3>Author-declared (hints)</h3>
          <ul>
            {author.map((r, i) => (
              <li key={`a${i}`}>
                {r.area}: {r.note}
              </li>
            ))}
          </ul>
          <h3>Reviewer-found</h3>
          <ul>
            {reviewer.map((r, i) => (
              <li key={`r${i}`}>
                {r.area}: {r.note}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "Meta":
      return (
        <p className="meta">
          domain={String(node.props.domain)} focus={String(node.props.focus)}
        </p>
      );
    case "ArchGraph": {
      const nodes = (node.props.nodes as Array<{ id: string; label: string }>) ?? [];
      const edges =
        (node.props.edges as Array<{ from: string; to: string; kind?: string }>) ?? [];
      return (
        <div className="arch-graph">
          <ul>
            {nodes.map((n) => (
              <li key={n.id}>
                <code>{n.id}</code> {n.label}
              </li>
            ))}
          </ul>
          <ul>
            {edges.map((e, i) => (
              <li key={i}>
                {e.from} → {e.to}
                {e.kind ? ` (${e.kind})` : ""}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "Callout":
      return <aside className="callout">{String(node.props.text ?? "")}</aside>;
    case "SuggestedPatch":
      return <pre>{String(node.props.diff ?? "")}</pre>;
    default:
      return <div data-unknown={node.type}>{kids}</div>;
  }
};

export function ProofRenderer({ spec }: { spec: Spec }) {
  return <div className="proof-page">{el(spec, spec.root)}</div>;
}
