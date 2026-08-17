import { describe, expect, it } from "vitest";
import { hashToken, newIngestToken } from "./crypto";
import { authorizeIngest, bearerToken, parseUpload } from "./ingest";
import type { RepoRow } from "./runs";

const repo = (token: string): RepoRow => ({
  id: "acme/widgets",
  owner: "acme",
  name: "widgets",
  ingestTokenHash: hashToken(token),
});

const validUpload = (over: Record<string, unknown> = {}) => ({
  repo: "acme/widgets",
  run: {
    id: "run:abc123:1",
    repoId: "repo:acme/widgets",
    skillPackHash: "a".repeat(64),
    domain: "GENERAL",
    createdAt: "2026-08-09T10:00:00.000Z",
  },
  understanding: {
    what: "Adds a retry to the webhook sender.",
    why: "Deliveries dropped when the receiver restarted.",
    how: "sender.ts retries three times with a delay.",
    proof_refs: [],
    risks: [],
  },
  proofSpec: { root: "workspace", elements: { workspace: { type: "Workspace", props: {} } } },
  ...over,
});

describe("ingest token auth", () => {
  it("accepts the token whose hash is stored", () => {
    const token = newIngestToken();
    expect(authorizeIngest(repo(token), token)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(authorizeIngest(repo(newIngestToken()), newIngestToken())).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(authorizeIngest(repo(newIngestToken()), null)).toBe(false);
  });

  it("rejects an unknown repo, whatever the token", () => {
    expect(authorizeIngest(null, newIngestToken())).toBe(false);
    expect(authorizeIngest(null, null)).toBe(false);
  });

  it("rejects a token that is a prefix of the right one", () => {
    const token = newIngestToken();
    expect(authorizeIngest(repo(token), token.slice(0, -1))).toBe(false);
  });

  it("reads the token out of an Authorization header, or nothing", () => {
    expect(bearerToken("Bearer vrt_abc")).toBe("vrt_abc");
    expect(bearerToken("bearer vrt_abc")).toBe("vrt_abc");
    expect(bearerToken("Basic vrt_abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("payload validation", () => {
  it("accepts a well formed run", () => {
    const parsed = parseUpload(validUpload(), "acme/widgets");
    expect(parsed.ok).toBe(true);
  });

  it("rejects an Understanding with an empty what", () => {
    const parsed = parseUpload(
      validUpload({
        understanding: {
          what: "",
          why: "why",
          how: "how",
          proof_refs: [],
          risks: [],
        },
      }),
      "acme/widgets",
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a run without a proof spec root", () => {
    const parsed = parseUpload(
      validUpload({ proofSpec: { elements: {} } }),
      "acme/widgets",
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a domain outside the enum", () => {
    const upload = validUpload();
    const parsed = parseUpload(
      { ...upload, run: { ...upload.run, domain: "VIBES" } },
      "acme/widgets",
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a payload for a different repo than the token authenticated", () => {
    const parsed = parseUpload(validUpload(), "acme/other");
    expect(parsed.ok).toBe(false);
  });

  it("rejects a log name that could walk out of the object store", () => {
    const parsed = parseUpload(
      validUpload({
        logs: [{ name: "../../etc/passwd", contentType: "text/plain", body: "x" }],
      }),
      "acme/widgets",
    );
    expect(parsed.ok).toBe(false);
  });

  it("strips an em dash the model slipped into the Understanding", () => {
    const parsed = parseUpload(
      validUpload({
        understanding: {
          what: "Adds a retry — three of them — to the sender.",
          why: "why",
          how: "how",
          proof_refs: [],
          risks: [],
        },
      }),
      "acme/widgets",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.upload.understanding.what).not.toContain("—");
  });

  it("rejects anything that is not an object", () => {
    for (const body of [null, 42, "run", []]) {
      expect(parseUpload(body, "acme/widgets").ok).toBe(false);
    }
  });
});
