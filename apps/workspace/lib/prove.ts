import path from "node:path";
import { runProve } from "@verit/application";
import { makeProveRunner } from "@verit/adapter-prove";
import type { Understanding } from "@verit/domain";
import type { ProveOutcome } from "@verit/ports";
import { Effect } from "effect";
import { docs } from "./stores";

/* The workspace reviews any PR, but it may only *run* code for the repo the
   operator pointed verit at: this checkout. Prove never fires on its own
   here. The UI shows the exact command and the user clicks it. */

export const PROVE_CWD = path.resolve(process.env.VERIT_PROVE_CWD ?? process.cwd());

const runner = makeProveRunner();

export interface ProveOffer {
  /** Whether this workspace may run prove for that repo at all. */
  allowed: boolean;
  /** Display form of what would run, e.g. `pnpm run test`. */
  command: string | null;
  cwd: string;
  /** Why it is unavailable, shown verbatim in the UI. */
  reason: string;
}

/** What prove would do for `repo`, before anyone clicks anything. */
export async function proveOffer(repo: string): Promise<ProveOffer> {
  const local = await Effect.runPromise(runner.repoAt(PROVE_CWD)).catch(() => null);
  if (!local) {
    return {
      allowed: false,
      command: null,
      cwd: PROVE_CWD,
      reason: `${PROVE_CWD} is not a GitHub checkout, so there is nothing local to prove against.`,
    };
  }
  if (local.toLowerCase() !== repo.toLowerCase()) {
    return {
      allowed: false,
      command: null,
      cwd: PROVE_CWD,
      reason: `This workspace runs in ${local}; proving ${repo} would mean executing another repo's code here. Point VERIT_PROVE_CWD at a ${repo} checkout to enable it.`,
    };
  }
  const cmd = await Effect.runPromise(runner.detect(PROVE_CWD)).catch(() => null);
  if (!cmd) {
    return {
      allowed: false,
      command: null,
      cwd: PROVE_CWD,
      reason: `No test command found in ${PROVE_CWD}. Set VERIT_PROVE_CMD to name one.`,
    };
  }
  return {
    allowed: true,
    command: [cmd.command, ...cmd.args].join(" "),
    cwd: PROVE_CWD,
    reason: `from ${cmd.source}`,
  };
}

const TIMEOUT_MS = Number(process.env.VERIT_PROVE_TIMEOUT_MS) || undefined;

/** Run prove for a finished ReviewRun and persist the evidence it produced. */
export async function proveReviewRun(input: {
  reviewRunId: string;
  repo: string;
  understanding: Understanding;
}): Promise<{ understanding: Understanding; outcome: ProveOutcome }> {
  const result = await Effect.runPromise(
    runProve({ prove: runner, docs: docs() })({
      runId: input.reviewRunId,
      cwd: PROVE_CWD,
      expectRepo: input.repo,
      understanding: input.understanding,
      timeoutMs: TIMEOUT_MS,
    }),
  );
  // runProve keeps the Understanding it was given; null only enters when the
  // caller had none, and this caller always has one.
  return {
    understanding: result.understanding ?? input.understanding,
    outcome: result.outcome,
  };
}

const PROVE_KEY = "u-prove-action";

/** SpecStream patches for the prove control in the Proof section. */
export function proveActionPatches(offer: ProveOffer): string[] {
  return [
    JSON.stringify({
      op: "add",
      path: `/elements/${PROVE_KEY}`,
      value: {
        type: "ProveAction",
        props: { ...offer },
        children: [],
      },
    }),
    JSON.stringify({ op: "add", path: "/elements/sec-proof/children/-", value: PROVE_KEY }),
  ];
}
