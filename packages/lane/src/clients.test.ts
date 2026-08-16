import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { anthropicClient } from "./anthropic";
import { LaneError, type LaneRequest } from "./client";
import { openaiCompatClient } from "./openai";

/*
 * Adapter tests against recorded wire fixtures. No live HTTP: fetch is a stub
 * that captures the request and replays a canned provider response.
 *
 * Fixture provenance:
 *  - anthropic: Messages API tool-use response shape from the Anthropic API
 *    reference bundled with the claude-api skill (cached 2026-06-24).
 *  - openai: chat completions tool-call response from the OpenAI API
 *    reference / openai-openapi spec (fetched 2026-08-17).
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const stubFetch = (
  payload: unknown,
  captured: Captured[],
  status = 200,
): typeof fetch =>
  (async (url: unknown, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;

const ANTHROPIC_TOOL_USE_FIXTURE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [
    { type: "text", text: "Let me check the file." },
    { type: "tool_use", id: "toolu_abc123", name: "read_file", input: { path: "a.ts" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50 },
};

const OPENAI_TOOL_CALL_FIXTURE = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1699896916,
  model: "grok-4",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: { name: "read_file", arguments: '{\n"path": "a.ts"\n}' },
          },
        ],
      },
      logprobs: null,
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 82, completion_tokens: 17, total_tokens: 99 },
};

const TOOL = {
  name: "read_file",
  description: "Read one file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const baseRequest: LaneRequest = {
  system: "system prompt",
  messages: [{ role: "user", content: "hello" }],
  tools: [TOOL],
  maxTokens: 16_000,
};

describe("anthropicClient", () => {
  it("maps request and tool-use response onto the lane shapes", async () => {
    const captured: Captured[] = [];
    const client = anthropicClient({
      apiKey: "test-key",
      model: "claude-opus-4-8",
      fetchImpl: stubFetch(ANTHROPIC_TOOL_USE_FIXTURE, captured),
    });
    const turn = await Effect.runPromise(client.complete(baseRequest));

    const req = captured[0]!;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("test-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body["model"]).toBe("claude-opus-4-8");
    expect(req.body["system"]).toBe("system prompt");
    expect(req.body["tools"]).toEqual([
      { name: "read_file", description: "Read one file", input_schema: TOOL.inputSchema },
    ]);
    expect(req.body["tool_choice"]).toBeUndefined();

    expect(turn.text).toBe("Let me check the file.");
    expect(turn.toolCalls).toEqual([
      {
        id: "toolu_abc123",
        name: "read_file",
        input: { path: "a.ts" },
        inputJson: '{"path":"a.ts"}',
      },
    ]);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(turn.raw).toEqual(ANTHROPIC_TOOL_USE_FIXTURE.content);
  });

  it("forces a named tool and replays history in Messages API shape", async () => {
    const captured: Captured[] = [];
    const raw = ANTHROPIC_TOOL_USE_FIXTURE.content;
    const client = anthropicClient({
      apiKey: "k",
      model: "m",
      baseUrl: "https://example.test",
      fetchImpl: stubFetch(ANTHROPIC_TOOL_USE_FIXTURE, captured),
    });
    await Effect.runPromise(
      client.complete({
        ...baseRequest,
        forceTool: "submit_understanding",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            text: "Let me check the file.",
            toolCalls: [
              { id: "toolu_abc123", name: "read_file", input: { path: "a.ts" }, inputJson: "{}" },
            ],
            raw,
          },
          {
            role: "tool_results",
            results: [{ toolCallId: "toolu_abc123", content: "file body", isError: true }],
          },
        ],
      }),
    );
    const body = captured[0]!.body;
    expect(captured[0]!.url).toBe("https://example.test/v1/messages");
    expect(body["tool_choice"]).toEqual({ type: "tool", name: "submit_understanding" });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    // The assistant turn is replayed verbatim from raw, thinking blocks and all.
    expect(messages[1]).toEqual({ role: "assistant", content: raw });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_abc123",
          content: "file body",
          is_error: true,
        },
      ],
    });
  });

  it("fails with a retryable LaneError on HTTP 429", async () => {
    const client = anthropicClient({
      apiKey: "k",
      model: "m",
      fetchImpl: stubFetch({ error: { type: "rate_limit_error" } }, [], 429),
    });
    const outcome = await Effect.runPromise(Effect.either(client.complete(baseRequest)));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(LaneError);
      expect(outcome.left.status).toBe(429);
      expect(outcome.left.retryable).toBe(true);
    }
  });
});

describe("openaiCompatClient", () => {
  it("maps request and tool-call response onto the lane shapes", async () => {
    const captured: Captured[] = [];
    const client = openaiCompatClient({
      apiKey: "xai-key",
      model: "grok-4",
      baseUrl: "https://api.x.ai/v1",
      fetchImpl: stubFetch(OPENAI_TOOL_CALL_FIXTURE, captured),
    });
    const turn = await Effect.runPromise(client.complete(baseRequest));

    const req = captured[0]!;
    expect(req.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(req.headers["authorization"]).toBe("Bearer xai-key");
    expect(req.body["model"]).toBe("grok-4");
    const messages = req.body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
    expect(req.body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read one file",
          parameters: TOOL.inputSchema,
        },
      },
    ]);

    expect(turn.text).toBeNull();
    expect(turn.toolCalls).toEqual([
      {
        id: "call_abc123",
        name: "read_file",
        input: { path: "a.ts" },
        inputJson: '{\n"path": "a.ts"\n}',
      },
    ]);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.usage).toEqual({ inputTokens: 82, outputTokens: 17 });
  });

  it("replays history: assistant tool_calls echo raw arguments, results become tool messages", async () => {
    const captured: Captured[] = [];
    const client = openaiCompatClient({
      apiKey: "k",
      model: "m",
      fetchImpl: stubFetch(OPENAI_TOOL_CALL_FIXTURE, captured),
    });
    await Effect.runPromise(
      client.complete({
        ...baseRequest,
        forceTool: "submit_understanding",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            text: null,
            toolCalls: [
              {
                id: "call_abc123",
                name: "read_file",
                input: { path: "a.ts" },
                inputJson: '{\n"path": "a.ts"\n}',
              },
            ],
          },
          {
            role: "tool_results",
            results: [
              { toolCallId: "call_abc123", content: "file body" },
              { toolCallId: "call_other", content: "boom", isError: true },
            ],
          },
        ],
      }),
    );
    const body = captured[0]!.body;
    expect(body["tool_choice"]).toEqual({
      type: "function",
      function: { name: "submit_understanding" },
    });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: { name: "read_file", arguments: '{\n"path": "a.ts"\n}' },
        },
      ],
    });
    // One tool message per result, ERROR-prefixed when the tool failed.
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_abc123",
      content: "file body",
    });
    expect(messages[4]).toEqual({
      role: "tool",
      tool_call_id: "call_other",
      content: "ERROR: boom",
    });
  });

  it("normalizes a compat quirk: finish_reason stop with tool calls present", async () => {
    const quirky = {
      ...OPENAI_TOOL_CALL_FIXTURE,
      choices: [
        {
          ...OPENAI_TOOL_CALL_FIXTURE.choices[0]!,
          finish_reason: "stop",
        },
      ],
    };
    const client = openaiCompatClient({
      apiKey: "k",
      model: "m",
      fetchImpl: stubFetch(quirky, []),
    });
    const turn = await Effect.runPromise(client.complete(baseRequest));
    expect(turn.stopReason).toBe("tool_use");
  });

  it("keeps unparseable tool arguments as undefined input with the raw text intact", async () => {
    const broken = {
      ...OPENAI_TOOL_CALL_FIXTURE,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "read_file", arguments: "{not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const client = openaiCompatClient({
      apiKey: "k",
      model: "m",
      fetchImpl: stubFetch(broken, []),
    });
    const turn = await Effect.runPromise(client.complete(baseRequest));
    expect(turn.toolCalls[0]?.input).toBeUndefined();
    expect(turn.toolCalls[0]?.inputJson).toBe("{not json");
  });

  it("fails with a non-retryable LaneError on HTTP 400", async () => {
    const client = openaiCompatClient({
      apiKey: "k",
      model: "m",
      fetchImpl: stubFetch({ error: { message: "bad request" } }, [], 400),
    });
    const outcome = await Effect.runPromise(Effect.either(client.complete(baseRequest)));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left.status).toBe(400);
      expect(outcome.left.retryable).toBe(false);
    }
  });
});
