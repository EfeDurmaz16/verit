import { describe, expect, it } from "vitest";
import { applySpecStream, catalogPrompt, PROOF_CATALOG } from "./catalog.js";

describe("proof catalog", () => {
  it("lists fixed components", () => {
    expect(PROOF_CATALOG).toContain("Understanding");
    expect(PROOF_CATALOG).toContain("ArchGraph");
    expect(PROOF_CATALOG).toContain("SuggestedPatch");
    expect(catalogPrompt()).toContain("Workspace");
  });

  it("applies SpecStream ops", () => {
    const base = {
      root: "workspace",
      elements: {
        workspace: { type: "Workspace", props: {}, children: [] as string[] },
      },
    };
    const next = applySpecStream(base, [
      { op: "set", id: "u", type: "Understanding", props: { what: "demo" } },
      { op: "appendChild", parent: "workspace", child: "u" },
    ]);
    expect(next.elements.workspace?.children).toEqual(["u"]);
    expect(next.elements.u?.props.what).toBe("demo");
  });
});
