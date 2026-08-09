import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readUnderstanding, understandingPatches, UNDERSTANDING_FILE } from "./understanding";

const dirWith = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "cyclops-u-"));
  writeFileSync(join(dir, UNDERSTANDING_FILE), body);
  return dir;
};

const VALID = {
  what: "Adds a token allowlist to the pay CLI.",
  why: "Merchants were charged in tokens they cannot settle.",
  how: "New guard in src/pay.ts rejects unlisted mints before quoting.",
  proof_refs: [{ kind: "command", label: "unit tests", value: "pnpm test src/pay.test.ts" }],
  out_of_scope: ["refunds"],
  risks: [
    { area: "compat", note: "existing integrations may pass unlisted mints", source: "author" },
    { area: "rounding", note: "quote is recomputed after the guard", source: "reviewer" },
  ],
};

describe("understanding lane contract", () => {
  it("accepts a schema-valid lane output", async () => {
    const r = await readUnderstanding(dirWith(JSON.stringify(VALID)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.understanding.what).toBe(VALID.what);
  });

  it("rejects a missing file, bad JSON, and a schema violation", async () => {
    const missing = await readUnderstanding(mkdtempSync(join(tmpdir(), "cyclops-u-")));
    expect(missing.ok).toBe(false);

    const torn = await readUnderstanding(dirWith("{ not json"));
    expect(torn.ok).toBe(false);

    // `how` is required and must be non-empty: an unverified run, not a rendered one
    const invalid = await readUnderstanding(dirWith(JSON.stringify({ ...VALID, how: "" })));
    expect(invalid.ok).toBe(false);
  });

  it("carries an executed proof's verdict and log into the render", async () => {
    const failed = {
      ...VALID,
      proof_refs: [
        {
          kind: "test",
          label: "prove: pnpm run test, failed",
          value: "exit 1 · 3.2s",
          status: "fail",
          log: "Error: 2 tests failed",
        },
      ],
    };
    const r = await readUnderstanding(dirWith(JSON.stringify(failed)));
    if (!r.ok) throw new Error(r.error);
    const proof = understandingPatches(r.understanding)
      .map((l) => JSON.parse(l) as { path: string; value: unknown })
      .find((p) => p.path === "/elements/u-proof")?.value as {
      props: { refs: { status?: string; log?: string }[] };
    };
    // dropping these would render a failed proof as neutral evidence
    expect(proof.props.refs[0]?.status).toBe("fail");
    expect(proof.props.refs[0]?.log).toContain("2 tests failed");
  });

  it("renders author and reviewer risks into separate props", async () => {
    const r = await readUnderstanding(dirWith(JSON.stringify(VALID)));
    if (!r.ok) throw new Error(r.error);
    const patches = understandingPatches(r.understanding).map(
      (l) => JSON.parse(l) as { op: string; path: string; value: unknown },
    );
    const risks = patches.find((p) => p.path === "/elements/u-risks")?.value as {
      props: { authorDeclared: unknown[]; reviewerFound: unknown[] };
    };
    expect(risks.props.authorDeclared).toHaveLength(1);
    expect(risks.props.reviewerFound).toHaveLength(1);

    // every element is added before any section references it
    const added = new Set<string>();
    for (const p of patches) {
      if (p.path.startsWith("/elements/") && !p.path.includes("/children")) {
        added.add(p.path.slice("/elements/".length));
      } else {
        expect(added.has(String(p.value))).toBe(true);
      }
    }
  });
});
