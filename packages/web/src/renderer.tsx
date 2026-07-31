import React from "react";
import type { RiskRow, Spec } from "./catalog.js";

const empty = (msg: string) => <p className="empty">{msg}</p>;

const UnderstandingView = ({ props }: { props: Record<string, unknown> }) => {
  const what = String(props.what ?? props.headline ?? "");
  const why = String(props.why ?? "");
  const how = String(props.how ?? "");
  return (
    <div className="understanding">
      <p className="kicker">What</p>
      <h1>{what || "No understanding yet"}</h1>
      <div className="wwih">
        <div>
          <p className="kicker">Why</p>
          <p>{why || "—"}</p>
        </div>
        <div>
          <p className="kicker">How</p>
          <p>{how || "—"}</p>
        </div>
      </div>
    </div>
  );
};

const ProofEvidenceView = ({ props }: { props: Record<string, unknown> }) => {
  const refs =
    (props.refs as Array<{ kind: string; label: string; value: string }>) ?? [];
  if (refs.length === 0) {
    return empty("No proof refs yet — honest empty state (not invented).");
  }
  return (
    <ul className="proof-refs">
      {refs.map((r, i) => (
        <li key={i}>
          <span className="kind">{r.kind}</span>
          <span className="label">{r.label}</span>
          <code>{r.value}</code>
        </li>
      ))}
    </ul>
  );
};

const RisksListView = ({ props }: { props: Record<string, unknown> }) => {
  const author = (props.authorDeclared as RiskRow[]) ?? [];
  const reviewer = (props.reviewerFound as RiskRow[]) ?? [];
  return (
    <div className="risks">
      <div className="risk-col">
        <h3>Author-declared</h3>
        <p className="hint">Hints only — never an allowlist for the reviewer.</p>
        {author.length === 0 ? (
          empty("No author risk hints in PR body.")
        ) : (
          <ul>
            {author.map((r, i) => (
              <li key={`a${i}`}>
                <strong>{r.area}</strong> {r.note}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="risk-col">
        <h3>Reviewer-found</h3>
        <p className="hint">Independent of author list.</p>
        {reviewer.length === 0 ? (
          empty("No reviewer risks recorded.")
        ) : (
          <ul>
            {reviewer.map((r, i) => (
              <li key={`r${i}`}>
                <strong>{r.area}</strong> {r.note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const ArchGraphView = ({ props }: { props: Record<string, unknown> }) => {
  const nodes = (props.nodes as Array<{ id: string; label: string }>) ?? [];
  const edges =
    (props.edges as Array<{ from: string; to: string; kind?: string }>) ?? [];
  if (nodes.length === 0 && edges.length === 0) {
    return empty("No architecture nodes from changed paths.");
  }
  return (
    <div className="arch-graph">
      <div className="arch-nodes">
        {nodes.map((n) => (
          <span key={n.id} className="node" title={n.id}>
            {n.label}
          </span>
        ))}
      </div>
      {edges.length > 0 && (
        <ul className="arch-edges">
          {edges.map((e, i) => (
            <li key={i}>
              <code>{e.from}</code> → <code>{e.to}</code>
              {e.kind ? <span className="kind"> {e.kind}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const MetaView = ({ props }: { props: Record<string, unknown> }) => {
  const out = (props.outOfScope as string[]) ?? [];
  return (
    <div className="meta">
      <p>
        <span className="kicker">domain</span> {String(props.domain ?? "—")}
        <span className="sep">·</span>
        <span className="kicker">focus</span> {String(props.focus ?? "none")}
      </p>
      {out.length > 0 && (
        <ul>
          {out.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

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
      return <UnderstandingView props={node.props} />;
    case "ProofEvidence":
      return <ProofEvidenceView props={node.props} />;
    case "RisksList":
      return <RisksListView props={node.props} />;
    case "Meta":
      return <MetaView props={node.props} />;
    case "ArchGraph":
      return <ArchGraphView props={node.props} />;
    case "Callout":
      return <aside className="callout">{String(node.props.text ?? "")}</aside>;
    case "SuggestedPatch": {
      const diff = String(node.props.diff ?? "");
      return diff ? <pre className="patch">{diff}</pre> : empty("No suggested patch.");
    }
    default:
      return <div data-unknown={node.type}>{kids}</div>;
  }
};

export function ProofRenderer({ spec }: { spec: Spec }) {
  return <div className="proof-page">{el(spec, spec.root)}</div>;
}
