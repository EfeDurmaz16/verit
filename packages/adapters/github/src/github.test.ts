import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeGithubChecks } from "./index";

/* The transport seam: a fetch that records the one request Octokit makes and
   answers as api.github.com would. Nothing leaves the process. */
const fakeTransport = () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ id: 1, html_url: "https://github.com/o/r/runs/1" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
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

describe("makeGithubChecks", () => {
  it.each(["success", "failure", "neutral"] as const)(
    "posts a completed %s check with name, conclusion and output",
    async (conclusion) => {
      const { calls, fetchStub } = fakeTransport();
      const port = makeGithubChecks("token-x", { fetch: fetchStub });
      const result = await Effect.runPromise(
        port.postCheckRun({ ...baseCheck, conclusion }),
      );
      expect(result).toEqual({ posted: true, url: "https://github.com/o/r/runs/1" });
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/repos/o/r/check-runs");
      expect(call.body).toMatchObject({
        name: "verit / behavior-proof",
        head_sha: "abc123",
        status: "completed",
        conclusion,
        output: { title: baseCheck.title, summary: baseCheck.summary },
      });
    },
  );

  it("is a dry run without a token: nothing posted, no request made", async () => {
    const { calls, fetchStub } = fakeTransport();
    const port = makeGithubChecks(undefined, { fetch: fetchStub });
    const result = await Effect.runPromise(
      port.postCheckRun({ ...baseCheck, conclusion: "success" }),
    );
    expect(result).toEqual({ posted: false, url: null });
    expect(calls).toHaveLength(0);
  });

  it("fails with a StoreError when GitHub rejects the check", async () => {
    const rejecting: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "Resource not accessible" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    const port = makeGithubChecks("token-x", { fetch: rejecting });
    const exit = await Effect.runPromiseExit(
      port.postCheckRun({ ...baseCheck, conclusion: "success" }),
    );
    expect(exit._tag).toBe("Failure");
  });
});
