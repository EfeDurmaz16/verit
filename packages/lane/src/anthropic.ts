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
 * Anthropic Messages API over plain fetch. No SDK.
 *
 * Wire shapes verified against the Anthropic API reference bundled with the
 * claude-api skill (cached 2026-06-24): POST /v1/messages with x-api-key and
 * anthropic-version headers; tools as {name, description, input_schema};
 * forced tool choice as {type: "tool", name}; tool results as tool_result
 * blocks inside ONE user message.
 */

const API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Only the blocks the lane reads. Anything else (thinking, ...) is replayed via `raw`. */
const TextBlock = S.Struct({ type: S.Literal("text"), text: S.String });
const ToolUseBlock = S.Struct({
  type: S.Literal("tool_use"),
  id: S.String,
  name: S.String,
  input: S.Unknown,
});

const WireResponse = S.Struct({
  content: S.Array(S.Unknown),
  stop_reason: S.NullOr(S.String),
  usage: S.optional(
    S.Struct({
      input_tokens: S.optional(S.Number),
      output_tokens: S.optional(S.Number),
    }),
  ),
});

const decodeResponse = S.decodeUnknownEither(WireResponse);
const decodeText = S.decodeUnknownEither(TextBlock);
const decodeToolUse = S.decodeUnknownEither(ToolUseBlock);

const stopReason = (wire: string | null): LaneStopReason => {
  switch (wire) {
    case "tool_use":
      return "tool_use";
    case "end_turn":
      return "end_turn";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
};

const wireMessages = (messages: readonly LaneMessage[]): unknown[] =>
  messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      // Replay the provider's own content when we have it, so thinking blocks
      // and exact ordering survive the round trip.
      if (m.raw !== undefined) return { role: "assistant", content: m.raw };
      const blocks: unknown[] = [];
      if (m.text !== null && m.text !== "") blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
      }
      return { role: "assistant", content: blocks };
    }
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });

const toTurn = (payload: unknown): Either.Either<LaneTurn, LaneError> => {
  const decoded = decodeResponse(payload);
  if (Either.isLeft(decoded)) {
    return Either.left(new LaneError(`anthropic: unexpected response shape`));
  }
  const r = decoded.right;
  const texts: string[] = [];
  const toolCalls: LaneToolCall[] = [];
  for (const block of r.content) {
    const tool = decodeToolUse(block);
    if (Either.isRight(tool)) {
      toolCalls.push({
        id: tool.right.id,
        name: tool.right.name,
        input: tool.right.input,
        inputJson: JSON.stringify(tool.right.input ?? {}),
      });
      continue;
    }
    const text = decodeText(block);
    if (Either.isRight(text) && text.right.text !== "") texts.push(text.right.text);
  }
  return Either.right({
    text: texts.length > 0 ? texts.join("\n") : null,
    toolCalls,
    stopReason: stopReason(r.stop_reason),
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
    },
    raw: r.content,
  });
};

export const anthropicClient = (options: LaneClientOptions): LaneClient => {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    complete: (request: LaneRequest) =>
      Effect.flatMap(
        Effect.tryPromise({
          try: () =>
            postJson({
              url: `${base}/v1/messages`,
              headers: {
                "x-api-key": options.apiKey,
                "anthropic-version": API_VERSION,
              },
              body: {
                model: options.model,
                max_tokens: request.maxTokens,
                system: request.system,
                messages: wireMessages(request.messages),
                tools: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema,
                })),
                ...(request.forceTool
                  ? { tool_choice: { type: "tool", name: request.forceTool } }
                  : {}),
              },
              timeoutMs,
              fetchImpl,
              label: "anthropic",
            }),
          catch: (e) =>
            e instanceof LaneError ? e : new LaneError(`anthropic: ${String(e)}`),
        }),
        (payload) => toTurn(payload),
      ),
  };
};
