import React from "react";
import { createRoot } from "react-dom/client";
import { ProofRenderer } from "./renderer.js";
import type { Spec } from "./catalog.js";
import demo from "./demo-spec.json" with { type: "json" };

const App = () => {
  const [spec, setSpec] = React.useState<Spec>(demo as Spec);
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const src = params.get("spec");
    if (!src) return;
    fetch(src)
      .then((r) => r.json())
      .then((j) => setSpec(j))
      .catch(() => undefined);
  }, []);
  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui",
        maxWidth: 880,
        margin: "2rem auto",
        padding: 16,
      }}
    >
      <p style={{ opacity: 0.6 }}>Cyclops proof page · json-render catalog</p>
      <ProofRenderer spec={spec} />
    </main>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
