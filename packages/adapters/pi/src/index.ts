import { spawnSync } from "node:child_process";
import { Either } from "effect";
import { Effect } from "effect";
import { decodeUnderstanding, type Understanding } from "@verit/domain";
import type { HarnessPort } from "@verit/ports";
import { StoreError } from "@verit/ports";
import { agentCli, runAgentUnderstand } from "./agent";

type UnderstandInput = Parameters<HarnessPort["runUnderstand"]>[0];

const trySpawnPi = (input: UnderstandInput): Understanding | null => {
  const bin = process.env.VERIT_PI_BIN;
  if (!bin) return null;
  const payload = JSON.stringify({
    verb: "understand",
    role: input.role,
    title: input.title,
    body: input.body,
    paths: input.paths,
    diff: input.diff,
    context: input.context,
  });
  const args = (process.env.VERIT_PI_ARGS ?? "understand --json").split(/\s+/).filter(Boolean);
  const r = spawnSync(bin, args, {
    input: payload,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    console.error(
      `[verit-pi] spawn failed status=${r.status} err=${r.error?.message ?? r.stderr?.slice(0, 400)}`,
    );
    return null;
  }
  const raw = (r.stdout ?? "").trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const line = raw
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .at(-1);
    if (!line) return null;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
  }
  const decoded = decodeUnderstanding(parsed);
  if (Either.isLeft(decoded)) {
    console.error("[verit-pi] Understanding decode failed", decoded.left);
    return null;
  }
  return decoded.right;
};

/**
 * Pi harness adapter.
 * If `VERIT_PI_BIN` is set, spawn that binary with JSON stdin (`VERIT_PI_ARGS`,
 * default `understand --json`). Unset, spawn failure, or invalid output all
 * yield null: analysis did not complete, and the run says so. There is no
 * synthetic Understanding to fall back to.
 */
export const makePiHarness = (): HarnessPort => ({
  runUnderstand: (input) =>
    Effect.try({
      try: () => trySpawnPi(input),
      catch: (e) => new StoreError("pi harness understand", e),
    }),
});

/**
 * Harness for the CLI and Action path, with the same selector the workspace
 * lane uses. `VERIT_LANE_HARNESS=claude|cursor` asks that CLI for the
 * Understanding; anything else keeps Pi.
 *
 * Every failure degrades to null instead of throwing: no API key, no CLI on
 * PATH, a timeout, or output that misses the schema. Null means the run
 * carries no Understanding, the Check goes neutral, and nothing downstream
 * can dress the run up as an analyzed one.
 */
export const makeAgentHarness = (): HarnessPort => ({
  runUnderstand: (input) =>
    Effect.try({
      try: () => {
        const cli = agentCli();
        const live = cli ? runAgentUnderstand(cli, input) : null;
        return live ?? trySpawnPi(input);
      },
      catch: (e) => new StoreError("agent harness understand", e),
    }),
});

export { agentCli, agentPrompt, extractUnderstanding, runAgentUnderstand } from "./agent";
export type { AgentCli } from "./agent";
