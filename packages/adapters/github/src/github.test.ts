import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { CheckAnnotation } from "@verit/ports";
import { makeGithubChecks, syncVeritLabel } from "./index";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/* The transport seam: a fetch that records every request Octokit makes and
   routes the three Check Runs calls (list, create, update) as GitHub would.
   Nothing leaves the process. `existing` seeds a prior Check Run of the same
   name so the re-run path can be exercised. */
const fakeTransport = (existing: Array<{ id: number; name: string }> = []) => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET" && url.includes("/check-runs")) {
      return json(200, { total_count: existing.length, check_runs: existing });
    }
    if (method === "POST" && url.endsWith("/check-runs")) {
      return json(201, { id: 1, html_url: "https://github.com/o/r/runs/1" });
    }
    const m = /\/check-runs\/(\d+)$/.exec(url);
    if (method === "PATCH" && m) {
      return json(200, { id: Number(m[1]), html_url: `https://github.com/o/r/runs/${m[1]}` });
    }
    return json(404, { message: "unrouted" });
  };
  return { calls, fetchStub };
};

const baseCheck = {
  owner: "o",
  repo: "r",
  headSha: "abc123",
  name: "verit / behavior-proof",
  title: "Proof passed: pnpm run test",
  summary: "**What changed:** w\n\n## Proof\n",
};

const annotations = (n: number): CheckAnnotation[] =>
  Array.from({ length: n }, (_, i) => ({
    path: "src/a.ts",
    startLine: i + 1,
    endLine: i + 1,
    annotationLevel: "warning" as const,
    message: `risk ${i}`,
    title: "verit: area",
  }));

describe("makeGithubChecks", () => {
  it.each(["success", "failure", "neutral"] as const)(
    "creates a completed %s check when none exists for the commit",
    async (conclusion) => {
      const { calls, fetchStub } = fakeTransport();
      const port = makeGithubChecks("token-x", { fetch: fetchStub });
      const result = await Effect.runPromise(port.postCheckRun({ ...baseCheck, conclusion }));
      expect(result).toEqual({ posted: true, url: "https://github.com/o/r/runs/1" });
      // it lists first (dedupe), then creates
      expect(calls.some((c) => c.method === "GET" && c.url.includes("/check-runs"))).toBe(true);
      const create = calls.find((c) => c.method === "POST");
      expect(create).toBeDefined();
      expect(create!.url).toContain("/repos/o/r/check-runs");
      expect(create!.body).toMatchObject({
        name: "verit / behavior-proof",
        head_sha: "abc123",
        status: "completed",
        conclusion,
        output: { title: baseCheck.title, summary: baseCheck.summary },
      });
    },
  );

  it("re-runs update the same Check Run instead of creating a duplicate", async () => {
    const { calls, fetchStub } = fakeTransport([{ id: 99, name: "verit / behavior-proof" }]);
    const port = makeGithubChecks("token-x", { fetch: fetchStub });
    const result = await Effect.runPromise(
      port.postCheckRun({ ...baseCheck, conclusion: "success" }),
    );
    expect(result.url).toBe("https://github.com/o/r/runs/99");
    // no create: the existing run is updated in place
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const update = calls.find((c) => c.method === "PATCH");
    expect(update).toBeDefined();
    expect(update!.url).toContain("/check-runs/99");
    expect(update!.body).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("posts annotations in the create output and carries details_url", async () => {
    const { calls, fetchStub } = fakeTransport();
    const port = makeGithubChecks("token-x", { fetch: fetchStub });
    await Effect.runPromise(
      port.postCheckRun({
        ...baseCheck,
        conclusion: "failure",
        annotations: annotations(2),
        detailsUrl: "https://proof.example/r/o/r/runs/1",
      }),
    );
    const create = calls.find((c) => c.method === "POST")!;
    const body = create.body as {
      details_url?: string;
      output: { annotations?: Array<Record<string, unknown>> };
    };
    expect(body.details_url).toBe("https://proof.example/r/o/r/runs/1");
    expect(body.output.annotations).toHaveLength(2);
    // mapped to GitHub's snake_case shape, verbatim lines
    expect(body.output.annotations![0]).toMatchObject({
      path: "src/a.ts",
      start_line: 1,
      end_line: 1,
      annotation_level: "warning",
      message: "risk 0",
    });
  });

  it("batches annotations to GitHub's 50-per-call limit", async () => {
    const { calls, fetchStub } = fakeTransport();
    const port = makeGithubChecks("token-x", { fetch: fetchStub });
    // 60 annotations: 50 on the create, 10 on a follow-up update to the same run
    await Effect.runPromise(
      port.postCheckRun({ ...baseCheck, conclusion: "failure", annotations: annotations(60) }),
    );
    const create = calls.find((c) => c.method === "POST")!;
    const createBody = create.body as { output: { annotations?: unknown[] } };
    expect(createBody.output.annotations).toHaveLength(50);
    const update = calls.find((c) => c.method === "PATCH")!;
    const updateBody = update.body as { output: { annotations?: unknown[] } };
    expect(updateBody.output.annotations).toHaveLength(10);
    expect(update.url).toContain("/check-runs/1");
  });

  it("is a dry run without a token: nothing posted, no request made", async () => {
    const { calls, fetchStub } = fakeTransport();
    const port = makeGithubChecks(undefined, { fetch: fetchStub });
    const result = await Effect.runPromise(
      port.postCheckRun({ ...baseCheck, conclusion: "success" }),
    );
    expect(result).toEqual({ posted: false, url: null });
    expect(calls).toHaveLength(0);
  });

  it("fails with a StoreError when GitHub rejects the write", async () => {
    // list is refused too, so the adapter falls back to create, which 403s
    const rejecting: typeof globalThis.fetch = async () =>
      json(403, { message: "Resource not accessible" });
    const port = makeGithubChecks("token-x", { fetch: rejecting });
    const exit = await Effect.runPromiseExit(
      port.postCheckRun({ ...baseCheck, conclusion: "success" }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("syncVeritLabel keeps exactly one label", () => {
  const managed = [
    "verit:proof-ready",
    "verit:needs-claim",
    "verit:needs-evidence",
    "verit:needs-corroboration",
    "verit:inconclusive",
  ];

  /** A fetch that records every call and answers the three label endpoints. */
  const stub = (present: string[]) => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl: typeof globalThis.fetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const href = String(url);
      calls.push({
        method,
        url: href,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      const body = method === "GET" ? present.map((name) => ({ name })) : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { calls, fetchImpl };
  };

  const run = async (present: string[], desired: string | null) => {
    const { calls, fetchImpl } = stub(present);
    const out = await syncVeritLabel({
      token: "t",
      owner: "EfeDurmaz16",
      repo: "verit",
      issueNumber: 10,
      desired,
      managed,
      fetch: fetchImpl,
    });
    return { out, calls };
  };

  it("adds the label when the pull request has none of ours", async () => {
    const { out, calls } = await run(["bug"], "verit:proof-ready");
    expect(out.added).toBe("verit:proof-ready");
    expect(out.removed).toEqual([]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("replaces the stale one instead of accumulating", async () => {
    const { out } = await run(["verit:needs-claim", "bug"], "verit:proof-ready");
    expect(out.removed).toEqual(["verit:needs-claim"]);
    expect(out.added).toBe("verit:proof-ready");
  });

  it("does nothing when the right label is already there", async () => {
    const { out, calls } = await run(["verit:proof-ready"], "verit:proof-ready");
    expect(out.added).toBeNull();
    expect(out.removed).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("never touches a label that is not ours", async () => {
    const { out, calls } = await run(["bug", "needs-triage"], "verit:inconclusive");
    expect(out.removed).toEqual([]);
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleted).toEqual([]);
  });

  it("closes, rejects and drafts nothing", async () => {
    const { calls } = await run(["verit:needs-claim"], "verit:proof-ready");
    const touched = calls.map((c) => c.url).join(" ");
    expect(touched).not.toContain("/merge");
    expect(touched).not.toContain("state");
  });

  it("reports a token that cannot write labels rather than failing the run", async () => {
    const out = await syncVeritLabel({
      owner: "EfeDurmaz16",
      repo: "verit",
      issueNumber: 10,
      desired: "verit:proof-ready",
      managed,
    });
    expect(out.error).toBe("no token");
    expect(out.added).toBeNull();
  });
});
