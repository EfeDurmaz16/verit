import React from "react";
import { createRoot } from "react-dom/client";
import { ProofRenderer } from "./renderer.js";
import type { Spec } from "./catalog.js";
import demo from "./demo-spec.json" with { type: "json" };
import "./styles.css";

const FIXTURES: Array<{ id: string; label: string; url: string }> = [
  { id: "demo", label: "Built-in demo", url: "" },
  { id: "pay415", label: "pay#415 sample", url: "/fixtures/pay-415.spec.json" },
  { id: "latest", label: "Latest dogfood (.data mirror)", url: "/fixtures/latest.spec.json" },
];

const loadSpec = async (url: string): Promise<Spec> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as Spec;
};

const App = () => {
  const [spec, setSpec] = React.useState<Spec>(demo as Spec);
  const [status, setStatus] = React.useState("demo fixture");
  const [selected, setSelected] = React.useState("demo");

  const apply = React.useCallback(async (id: string, url: string) => {
    setSelected(id);
    if (!url) {
      setSpec(demo as Spec);
      setStatus("demo fixture");
      return;
    }
    try {
      const next = await loadSpec(url);
      setSpec(next);
      setStatus(`loaded ${url}`);
    } catch (e) {
      setStatus(`failed ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const src = params.get("spec");
    if (src) {
      void apply("custom", src);
      return;
    }
    const fixture = params.get("fixture");
    if (fixture === "pay415" || fixture === "pay-415") {
      void apply("pay415", "/fixtures/pay-415.spec.json");
    }
  }, [apply]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Cyclops · json-render proof</div>
        <div className="controls">
          <label>
            <span className="status">Source </span>
            <select
              value={selected}
              onChange={(e) => {
                const f = FIXTURES.find((x) => x.id === e.target.value);
                if (f) void apply(f.id, f.url);
              }}
            >
              {FIXTURES.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void apply("pay415", "/fixtures/pay-415.spec.json")}>
            Open pay#415
          </button>
        </div>
        <p className="status">{status}</p>
      </header>
      <ProofRenderer spec={spec} />
    </div>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
