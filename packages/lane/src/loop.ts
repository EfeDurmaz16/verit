import { Effect, Either } from "effect";
import { decodeUnderstanding, type Understanding } from "@verit/domain";
import {
  LaneError,
  type LaneClient,
  type LaneMessage,
  type LaneTool,
  type LaneToolResult,
  type LaneTurn,
} from "./client";
import { SUBMIT_TOOL_NAME } from "./prompt";
import type { ToolOutcome } from "./tools";

/*
 * The thin agent loop.
 *
 * Invariants, in order of importance:
 *  1. Null is the only failure value. A cap hit, an HTTP failure, a refusal,
 *     or an invalid submit all return null; the pipeline's honest-neutral path
 *     handles it. The loop never invents an Understanding.
 *  2. Hard caps before every model call: turns, wall clock, total tokens.
 *     The wall clock also races each in-flight call, so a hung request cannot
 *     hold the lane past its deadline.
 *  3. The Understanding leaves the model only through the submit_understanding
 *     tool. When the model stops calling tools without submitting, the loop
 *     makes one final call that forces that tool. No JSON is scraped out of
 *     prose on this path.
 *  4. Tool results always answer every tool call of the turn they belong to
 *     (a truncated turn gets error results), so the wire history stays valid
 *     for both providers.
 */

export interface LaneCaps {
  /** Model calls, forced final call included. */
  readonly maxTurns: number;
  /** Wall clock for the whole loop. */
  readonly timeoutMs: number;
  /** Sum of input and output tokens across all calls. */
  readonly maxTotalTokens: number;
}

export const DEFAULT_CAPS: LaneCaps = {
  maxTurns: 40,
  timeoutMs: 900_000,
  maxTotalTokens: 4_000_000,
};

const MAX_TOKENS_PER_TURN = 16_000;
const RETRY_DELAY_MS = 2_000;

const NUDGE = `Call ${SUBMIT_TOOL_NAME} now with your final Understanding of this pull request.`;

export interface RunLaneInput {
  readonly system: string;
  readonly user: string;
  /** Workspace tools. The submit tool is appended by the loop. */
  readonly tools: readonly LaneTool[];
  readonly submitTool: LaneTool;
  readonly executeTool: (name: string, input: unknown) => ToolOutcome | Promise<ToolOutcome>;
  readonly caps?: Partial<LaneCaps>;
}

const log = (message: string): void => {
  console.error(`[verit-lane] ${message}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Race a promise against the remaining wall clock. Null means the clock won. */
const withDeadline = async <T>(work: Promise<T>, remainingMs: number): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), Math.max(remainingMs, 0));
  });
  try {
    return await Promise.race([work, clock]);
  } finally {
    clearTimeout(timer);
  }
};

const decodeSubmit = (input: unknown): Understanding | null => {
  const decoded = decodeUnderstanding(input);
  if (Either.isLeft(decoded)) {
    log(`${SUBMIT_TOOL_NAME} carried an invalid Understanding, run stays unanalyzed`);
    return null;
  }
  return decoded.right;
};

const assistantMessage = (turn: LaneTurn): LaneMessage => ({
  role: "assistant",
  text: turn.text,
  toolCalls: turn.toolCalls,
  raw: turn.raw,
});

export const runLane = async (
  client: LaneClient,
  input: RunLaneInput,
): Promise<Understanding | null> => {
  const caps: LaneCaps = { ...DEFAULT_CAPS, ...input.caps };
  const allTools: readonly LaneTool[] = [...input.tools, input.submitTool];
  const startedAt = Date.now();
  const messages: LaneMessage[] = [{ role: "user", content: input.user }];
  let turnsUsed = 0;
  let tokensUsed = 0;

  const remainingMs = (): number => caps.timeoutMs - (Date.now() - startedAt);

  /** One model call under every cap. Null means a cap or the API stopped the lane. */
  const callModel = async (forceSubmit: boolean): Promise<LaneTurn | null> => {
    if (turnsUsed >= caps.maxTurns) {
      log(`turn cap hit (${caps.maxTurns}), returning null`);
      return null;
    }
    if (tokensUsed >= caps.maxTotalTokens) {
      log(`token cap hit (${tokensUsed} of ${caps.maxTotalTokens}), returning null`);
      return null;
    }
    if (remainingMs() <= 0) {
      log(`wall clock cap hit (${caps.timeoutMs}ms), returning null`);
      return null;
    }
    turnsUsed += 1;
    const request = {
      system: input.system,
      messages: [...messages],
      tools: allTools,
      maxTokens: MAX_TOKENS_PER_TURN,
      ...(forceSubmit ? { forceTool: SUBMIT_TOOL_NAME } : {}),
    };
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await withDeadline(
        Effect.runPromise(Effect.either(client.complete(request))),
        remainingMs(),
      );
      if (outcome === null) {
        log(`wall clock cap hit mid-request (${caps.timeoutMs}ms), returning null`);
        return null;
      }
      if (Either.isRight(outcome)) {
        tokensUsed += outcome.right.usage.inputTokens + outcome.right.usage.outputTokens;
        return outcome.right;
      }
      const error = outcome.left;
      const retryable = error instanceof LaneError && error.retryable;
      if (retryable && attempt === 0 && remainingMs() > RETRY_DELAY_MS) {
        log(`retrying once after: ${error.message}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      log(`model call failed: ${error.message}`);
      return null;
    }
  };

  const submitFrom = (turn: LaneTurn): Understanding | null | undefined => {
    const submit = turn.toolCalls.find((c) => c.name === SUBMIT_TOOL_NAME);
    if (submit === undefined) return undefined;
    return decodeSubmit(submit.input);
  };

  const finishForced = async (): Promise<Understanding | null> => {
    const turn = await callModel(true);
    if (turn === null) return null;
    if (turn.stopReason === "refusal") {
      log("model refused the forced submit, returning null");
      return null;
    }
    const submitted = submitFrom(turn);
    if (submitted === undefined) {
      log("forced call returned no submit_understanding, returning null");
      return null;
    }
    return submitted;
  };

  while (true) {
    const turn = await callModel(false);
    if (turn === null) return null;
    if (turn.stopReason === "refusal") {
      log("model refused, returning null");
      return null;
    }

    const submitted = submitFrom(turn);
    if (submitted !== undefined) return submitted;

    if (turn.toolCalls.length === 0) {
      // The model stopped talking without submitting. Echo what it said, then
      // force the submit tool once. An empty assistant turn is not echoed:
      // both wire formats reject it.
      if (turn.raw !== undefined || turn.text !== null) {
        messages.push(assistantMessage(turn));
      }
      messages.push({ role: "user", content: NUDGE });
      return finishForced();
    }

    messages.push(assistantMessage(turn));
    const results: LaneToolResult[] = [];
    if (turn.stopReason === "tool_use") {
      for (const call of turn.toolCalls) {
        const outcome = await input.executeTool(call.name, call.input);
        results.push({
          toolCallId: call.id,
          content: outcome.content,
          ...(outcome.isError ? { isError: true } : {}),
        });
      }
    } else {
      // Truncated or odd turn: the calls may carry cut-off input. Answer them
      // so the history stays valid, then force the submit.
      for (const call of turn.toolCalls) {
        results.push({
          toolCallId: call.id,
          content: "not executed: the turn was cut off before the call completed",
          isError: true,
        });
      }
    }
    messages.push({ role: "tool_results", results });
    if (turn.stopReason !== "tool_use") {
      return finishForced();
    }
  }
};
