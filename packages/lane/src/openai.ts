import { Effect, Either, Schema as S } from "effect";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LaneError,
  postJson,
  type LaneClient,
  type LaneClientOptions,
  type LaneMessage,
  type LaneRequest,
  type LaneStopReason,
  type LaneToolCall,
  type LaneTurn,
} from "./client";

/*
 * OpenAI-compatible chat completions over plain fetch. No SDK.
 *
 * One adapter covers OpenAI, Grok (api.x.ai/v1), DeepSeek, GLM, and local
 * vLLM: they all speak this wire format. Shapes verified against the OpenAI
 * OpenAPI spec (github.com/openai/openai-openapi, fetched 2026-08-17):
 * tools as {type: "function", function: {name, description, parameters}};
 * forced tool choice as {type: "function", function: {name}}; results as one
 * {role: "tool", tool_call_id, content} message per call; tool_calls carry
 * arguments as a JSON string the caller must parse.
 *
 * ponytail: `max_tokens` is the field every compat provider accepts. OpenAI's
 * newest models want max_completion_tokens instead; a pinned model that
 * rejects max_tokens surfaces as an explicit HTTP 400 and the lane goes null.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const WireToolCall = S.Struct({
  id: S.String,
  function: S.Struct({ name: S.String, arguments: S.String }),
});

const WireResponse = S.Struct({
  choices: S.Array(
    S.Struct({
      message: S.Struct({
        content: S.optional(S.NullOr(S.String)),
        tool_calls: S.optional(S.Array(WireToolCall)),
      }),
      finish_reason: S.optional(S.NullOr(S.String)),
    }),
  ),
  usage: S.optional(
    S.Struct({
      prompt_tokens: S.optional(S.Number),
      completion_tokens: S.optional(S.Number),
    }),
  ),
});

const decodeResponse = S.decodeUnknownEither(WireResponse);

const stopReason = (wire: string | null | undefined): LaneStopReason => {
  switch (wire) {
    case "tool_calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
};

const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw === "" ? "{}" : raw) as unknown;
  } catch {
    return undefined;
  }
};

const wireMessages = (system: string, messages: readonly LaneMessage[]): unknown[] => {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text,
        ...(m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.inputJson },
              })),
            }
          : {}),
      });
    } else {
      // The OpenAI wire wants one tool message per call, not one batch.
      for (const r of m.results) {
        out.push({
          role: "tool",
          tool_call_id: r.toolCallId,
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
    }
  }
  return out;
};

const toTurn = (payload: unknown): Either.Either<LaneTurn, LaneError> => {
  const decoded = decodeResponse(payload);
  if (Either.isLeft(decoded)) {
    return Either.left(new LaneError(`openai-compat: unexpected response shape`));
  }
  const r = decoded.right;
  const choice = r.choices[0];
  if (choice === undefined) {
    return Either.left(new LaneError(`openai-compat: response has no choices`));
  }
  const toolCalls: LaneToolCall[] = (choice.message.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function.name,
    input: parseArguments(c.function.arguments),
    inputJson: c.function.arguments,
  }));
  const mapped = stopReason(choice.finish_reason);
  return Either.right({
    text: choice.message.content ?? null,
    toolCalls,
    // Some compat servers report finish_reason "stop" while returning tool
    // calls. Calls present and not truncated means the model used tools.
    stopReason: toolCalls.length > 0 && mapped !== "max_tokens" ? "tool_use" : mapped,
    usage: {
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
    },
  });
};

export const openaiCompatClient = (options: LaneClientOptions): LaneClient => {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    complete: (request: LaneRequest) =>
      Effect.flatMap(
        Effect.tryPromise({
          try: () =>
            postJson({
              url: `${base}/chat/completions`,
              headers: { authorization: `Bearer ${options.apiKey}` },
              body: {
                model: options.model,
                max_tokens: request.maxTokens,
                messages: wireMessages(request.system, request.messages),
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                  },
                })),
                ...(request.forceTool
                  ? {
                      tool_choice: {
                        type: "function",
                        function: { name: request.forceTool },
                      },
                    }
                  : {}),
              },
              timeoutMs,
              fetchImpl,
              label: "openai-compat",
            }),
          catch: (e) =>
            e instanceof LaneError ? e : new LaneError(`openai-compat: ${String(e)}`),
        }),
        (payload) => toTurn(payload),
      ),
  };
};
