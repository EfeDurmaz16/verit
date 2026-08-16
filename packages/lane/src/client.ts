import type { Effect } from "effect";

/*
 * The LaneClient port: the one seam between the agent loop and a model API.
 *
 * Both adapters (Anthropic Messages, OpenAI-compatible chat completions) map
 * this neutral shape onto their wire format. The loop never sees a wire type,
 * so a new provider is a new adapter and nothing else.
 */

/** One tool the model may call. `inputSchema` is plain JSON Schema. */
export interface LaneTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface LaneToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed JSON input. Undefined when the provider sent unparseable JSON. */
  readonly input: unknown;
  /** Raw JSON text of the input, echoed verbatim on the OpenAI wire. */
  readonly inputJson: string;
}

export interface LaneToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type LaneMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly text: string | null;
      readonly toolCalls: readonly LaneToolCall[];
      /**
       * Provider-opaque echo payload. The Anthropic adapter stores the whole
       * response content here so thinking blocks replay unchanged on the next
       * turn; dropping them breaks tool use on thinking models.
       */
      readonly raw?: unknown;
    }
  | { readonly role: "tool_results"; readonly results: readonly LaneToolResult[] };

export interface LaneRequest {
  readonly system: string;
  readonly messages: readonly LaneMessage[];
  readonly tools: readonly LaneTool[];
  readonly maxTokens: number;
  /** Name of the one tool the model must call, when set. */
  readonly forceTool?: string;
}

export type LaneStopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other";

export interface LaneUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One assistant turn: text, tool calls, why it stopped, what it cost. */
export interface LaneTurn {
  readonly text: string | null;
  readonly toolCalls: readonly LaneToolCall[];
  readonly stopReason: LaneStopReason;
  readonly usage: LaneUsage;
  /** Adapter-owned echo payload, see LaneMessage. */
  readonly raw?: unknown;
}

export class LaneError extends Error {
  readonly _tag = "LaneError" as const;
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export interface LaneClient {
  readonly complete: (request: LaneRequest) => Effect.Effect<LaneTurn, LaneError>;
}

/** Shared config for both HTTP adapters. The key lives here and nowhere else. */
export interface LaneClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /** Hard cap on one HTTP request. Default 10 minutes. */
  readonly requestTimeoutMs?: number;
  /** Test seam. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/**
 * POST one JSON body, return the parsed JSON response. Non-2xx and network
 * failures become LaneError; the response body tail rides along for debugging
 * (error bodies never contain the API key).
 */
export const postJson = async (input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly label: string;
}): Promise<unknown> => {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...input.headers },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (e) {
    throw new LaneError(
      `${input.label}: request failed: ${e instanceof Error ? e.message : String(e)}`,
      undefined,
      true,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new LaneError(
      `${input.label}: HTTP ${response.status}: ${text.slice(0, 400)}`,
      response.status,
      retryableStatus(response.status),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LaneError(`${input.label}: response is not JSON: ${text.slice(0, 200)}`);
  }
};
