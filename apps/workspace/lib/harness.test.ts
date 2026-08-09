import { describe, expect, it } from "vitest";
import { laneAdapter, type LaneAdapter, type LaneLine } from "./harness";

const PROMPT = "analyse this PR";

const lines = (a: LaneAdapter, ...raw: string[]): LaneLine[] =>
  raw.flatMap((r) => [...a.parse(r)]);

describe("harness selection", () => {
  it("defaults to codex when unset", () => {
    expect(laneAdapter(undefined).name).toBe("codex");
    expect(laneAdapter("").name).toBe("codex");
  });

  it("selects claude and cursor by name", () => {
    expect(laneAdapter("claude").name).toBe("claude");
    expect(laneAdapter("cursor").name).toBe("cursor");
  });

  it("throws on a typo instead of silently running the wrong CLI", () => {
    expect(() => laneAdapter("claude-code")).toThrow(/codex, claude or cursor/);
  });
});

describe("codex adapter", () => {
  const codex = laneAdapter("codex");

  it("builds a fresh exec invocation with the sandbox flags and the prompt last", () => {
    const spec = codex.spawn({ prompt: PROMPT });
    expect(spec.bin).toBe("codex");
    expect(spec.promptOnStdin).toBe(false);
    expect(spec.args[0]).toBe("exec");
    expect(spec.args).toContain("--skip-git-repo-check");
    expect(spec.args.at(-1)).toBe(PROMPT);
    expect(spec.args).not.toContain("resume");
  });

  it("adds the model flag only when a model is given", () => {
    expect(codex.spawn({ prompt: PROMPT }).args).not.toContain("-m");
    const spec = codex.spawn({ prompt: PROMPT, model: "gpt-5" });
    expect(spec.args.join(" ")).toContain("-m gpt-5");
  });

  it("cannot resume, so a session id never reaches argv", () => {
    expect(codex.supportsResume).toBe(false);
    const spec = codex.spawn({ prompt: PROMPT, resumeSessionId: "t-1" });
    // spawn() still honours an explicit id; runAgent is what withholds it
    expect(spec.args).toContain("resume");
  });

  it("reports the thread id and the commands it runs", () => {
    expect(
      lines(
        codex,
        '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"rg  -n   pay  src/"}}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"first line\\nsecond line"}}',
      ),
    ).toEqual([
      { sessionId: "11111111-2222-3333-4444-555555555555" },
      { activity: "rg -n pay src/" },
      { activity: "first line" },
    ]);
  });

  it("drops its own SpecStream appends and unparseable lines", () => {
    expect(
      lines(
        codex,
        '{"type":"item.completed","item":{"type":"command_execution","command":"printf %s x >> blocks.ndjson"}}',
        "not json at all",
        '{"type":"item.completed"}',
      ),
    ).toEqual([]);
  });
});

describe("claude adapter", () => {
  const claude = laneAdapter("claude");

  it("pairs stream-json with the verbose flag the CLI demands", () => {
    const spec = claude.spawn({ prompt: PROMPT });
    expect(spec.bin).toBe("claude");
    expect(spec.args).toContain("-p");
    expect(spec.args.join(" ")).toContain("--output-format stream-json");
    expect(spec.args).toContain("--verbose");
    expect(spec.args).toContain("--safe-mode");
  });

  it("keeps the prompt off argv so the variadic tool flag cannot swallow it", () => {
    const spec = claude.spawn({ prompt: PROMPT });
    expect(spec.promptOnStdin).toBe(true);
    expect(spec.args).not.toContain(PROMPT);
    // the variadic flag must be last, with nothing behind it to absorb
    expect(spec.args.at(-2)).toBe("--allowedTools");
  });

  it("passes model and resume through, and omits them when absent", () => {
    const bare = claude.spawn({ prompt: PROMPT });
    expect(bare.args).not.toContain("--model");
    expect(bare.args).not.toContain("--resume");
    const full = claude.spawn({ prompt: PROMPT, model: "opus", resumeSessionId: "abc-123" });
    expect(full.args.join(" ")).toContain("--model opus");
    expect(full.args.join(" ")).toContain("--resume abc-123");
    expect(claude.supportsResume).toBe(true);
  });

  it("reads the session id, tool calls, thinking and text", () => {
    expect(
      lines(
        claude,
        '{"type":"system","subtype":"init","session_id":"f41632ef-92f3-4694-a208-5f6c95db368a"}',
        '{"type":"system","subtype":"thinking_tokens","estimated_tokens":12}',
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"read the diff\\nthen risks"},{"type":"tool_use","name":"Bash","input":{"command":"sed -n 1,80p diff.patch"}},{"type":"tool_use","name":"Read","input":{}},{"type":"text","text":"done"}]}}',
        '{"type":"user","message":{"content":[]}}',
      ),
    ).toEqual([
      { sessionId: "f41632ef-92f3-4694-a208-5f6c95db368a" },
      { activity: "read the diff" },
      { activity: "sed -n 1,80p diff.patch" },
      { activity: "Read" },
      { activity: "done" },
    ]);
  });

  it("surfaces a failed result and stays quiet on a successful one", () => {
    expect(
      lines(claude, '{"type":"result","subtype":"success","is_error":false,"result":"done"}'),
    ).toEqual([]);
    const [err] = lines(
      claude,
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"credit balance too low"}',
    );
    expect(err?.error).toContain("credit balance too low");
  });
});

describe("cursor adapter", () => {
  const cursor = laneAdapter("cursor");

  it("builds a forced print-mode invocation carrying the prompt on argv", () => {
    const spec = cursor.spawn({ prompt: PROMPT });
    expect(spec.bin).toBe("cursor-agent");
    expect(spec.promptOnStdin).toBe(false);
    expect(spec.args.slice(0, 2)).toEqual(["-p", PROMPT]);
    expect(spec.args.join(" ")).toContain("--output-format stream-json");
    expect(spec.args).toContain("--force");
  });

  it("passes model and resume through", () => {
    expect(cursor.supportsResume).toBe(true);
    const spec = cursor.spawn({ prompt: PROMPT, model: "sonnet-4-thinking", resumeSessionId: "c9" });
    expect(spec.args.join(" ")).toContain("--model sonnet-4-thinking");
    expect(spec.args.join(" ")).toContain("--resume c9");
  });

  it("reads the session id, shell and read tool calls, and final text", () => {
    expect(
      lines(
        cursor,
        '{"type":"system","subtype":"init","session_id":"f76aa9be-165f-4bd3-bc1e-10d56cc7470f","cwd":"/w"}',
        '{"type":"thinking","subtype":"delta","text":"Reading note"}',
        '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"cat pr.json"}}}}',
        '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"/w/diff.patch"}}}}',
        '{"type":"tool_call","subtype":"completed","tool_call":{"shellToolCall":{"args":{"command":"cat pr.json"}}}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
      ),
    ).toEqual([
      { sessionId: "f76aa9be-165f-4bd3-bc1e-10d56cc7470f" },
      { activity: "cat pr.json" },
      { activity: "read /w/diff.patch" },
      { activity: "done" },
    ]);
  });

  it("surfaces a failed result", () => {
    const [err] = lines(cursor, '{"type":"result","subtype":"error","is_error":true,"result":"quota"}');
    expect(err?.error).toContain("quota");
  });
});
