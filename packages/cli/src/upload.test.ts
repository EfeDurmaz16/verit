import { describe, expect, it } from "vitest";
import { buildUpload, dashboardTarget, proofPageUrl } from "./upload";

describe("proof page URL", () => {
  it("is the URL shape the Check Run links to", () => {
    expect(proofPageUrl("https://verit.dev", "acme/widgets", "run:abc:1")).toBe(
      "https://verit.dev/r/acme/widgets/runs/run%3Aabc%3A1",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(proofPageUrl("http://localhost:3001/", "acme/widgets", "run:1")).toBe(
      "http://localhost:3001/r/acme/widgets/runs/run%3A1",
    );
  });
});

describe("upload gating", () => {
  it("stays off unless both variables are set", () => {
    expect(dashboardTarget({})).toBeNull();
    expect(dashboardTarget({ VERIT_DASHBOARD_URL: "http://x" })).toBeNull();
    expect(dashboardTarget({ VERIT_INGEST_TOKEN: "vrt_x" })).toBeNull();
    expect(dashboardTarget({ VERIT_DASHBOARD_URL: " ", VERIT_INGEST_TOKEN: "vrt_x" })).toBeNull();
  });

  it("turns on when both are set", () => {
    expect(
      dashboardTarget({ VERIT_DASHBOARD_URL: "http://x", VERIT_INGEST_TOKEN: "vrt_x" }),
    ).toEqual({ baseUrl: "http://x", token: "vrt_x" });
  });
});

const run = {
  id: "run:abc:1",
  repoId: "repo:acme/widgets",
  skillPackHash: "a".repeat(64),
  domain: "GENERAL" as const,
  createdAt: "2026-08-09T10:00:00.000Z",
};

const understanding = {
  what: "what",
  why: "why",
  how: "how",
  proof_refs: [],
  risks: [],
};

describe("buildUpload", () => {
  it("carries the full log as a blob and the tail on the run", () => {
    const upload = buildUpload({
      repo: "acme/widgets",
      run,
      understanding,
      proofSpec: { root: "workspace", elements: {} },
      outcome: {
        command: "pnpm run test",
        source: "package.json#scripts.test",
        cwd: "/tmp/r",
        repo: "acme/widgets",
        exitCode: 0,
        durationMs: 1200,
        timedOut: false,
        logTail: "ok\n",
        log: "line one\nline two\nok\n",
        startedAt: "2026-08-09T10:00:00.000Z",
        headSha: "abc1234",
        porcelainClean: true,
      },
    });
    expect(upload.prove?.logTail).toBe("ok\n");
    expect(upload.logs?.[0]?.name).toBe("prove.log");
    expect(upload.logs?.[0]?.body).toContain("line one");
  });

  it("sends no prove block and no logs when nothing ran", () => {
    const upload = buildUpload({
      repo: "acme/widgets",
      run,
      understanding,
      proofSpec: { root: "workspace", elements: {} },
      outcome: null,
    });
    expect(upload.prove).toBeUndefined();
    expect(upload.logs).toBeUndefined();
  });
});
