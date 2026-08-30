import { Effect, Either, JSONSchema, Schema as S } from "effect";
import type { Claim } from "@verit/domain";
import type { LaneClient, LaneRequest, LaneTool } from "./client";

/*
 * Probe generation, the half of the claim to probe compiler a model does.
 *
 * The repository is asked first, elsewhere. This runs only for a claim its own
 * tests do not speak to, and what it writes is marked `generated` and stays
 * that way. Provenance is bookkeeping, never a quality signal: a generated
 * probe that clears every integrity gate is a candidate, exactly like a
 * repo-native one, and only an independent second result makes either
 * corroborated. Nothing here can raise a grade.
 *
 * A generated probe is model-authored code that will execute, so what it may
 * do is stated in the prompt and what it actually did is bounded by the
 * isolation the execution job runs under. The honest failure is to produce
 * nothing: a claim with no probe is needs-evidence, which is a true statement
 * about the run.
 */

export const PROBE_TOOL_NAME = "submit_probe";

const GeneratedProbe = S.Struct({
  /** The probe source, complete and runnable as a single file. */
  source: S.String.pipe(S.minLength(1)),
  /** File name the probe is written as, with the extension its runner needs. */
  fileName: S.String.pipe(S.minLength(1)),
  /** The binary to run. Argv, never a shell string. */
  command: S.String.pipe(S.minLength(1)),
  /** Arguments. Use the token {probe} where the probe's own path belongs. */
  args: S.Array(S.String),
  /**
   * Repo-relative path to copy the probe to before running, when the runner
   * will only load a file from inside the project. Omit when it can run from
   * anywhere.
   */
  installPath: S.optional(S.String),
  /**
   * What this probe asserts, in one line, so a maintainer can tell whether it
   * measures the claim without reading the source.
   */
  asserts: S.String.pipe(S.minLength(1)),
});
export type GeneratedProbe = S.Schema.Type<typeof GeneratedProbe>;

export const ProbeSubmission = S.Struct({
  /** Empty when the model cannot write a probe that would measure the claim. */
  probes: S.Array(GeneratedProbe),
});
export type ProbeSubmission = S.Schema.Type<typeof ProbeSubmission>;

const decodeProbeSubmission = S.decodeUnknownEither(ProbeSubmission);

export const probeJsonSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(JSON.stringify(JSONSchema.make(ProbeSubmission))) as Record<
    string,
    unknown
  >;
  delete schema["$schema"];
  return schema;
};

const probeTool = (): LaneTool => ({
  name: PROBE_TOOL_NAME,
  description:
    "Submit probes that would measure this claim on both the base and the head commit. Call exactly once, then stop.",
  inputSchema: probeJsonSchema(),
});

const PROBE_SYSTEM = `You write one probe for one behavioral claim.

The probe runs twice: once against the base commit and once against the head commit, in identical conditions. What it measures is the difference between them, so it must assert the behavior itself, not the shape of the code. A probe that greps for a function name passes on both sides and measures nothing.

Rules that make a probe usable:
- It must exit non-zero when the behavior is wrong and zero when it is right. That exit code is the entire result.
- It must be one self-contained file, runnable by the command and args you give.
- It must not reach the network, and it must not depend on anything outside the repository it runs in.
- It MAY start processes. A claim about what a command does is proved by running that command and reading its exit code and output, not by reading the source that implements it. Reading source proves the code says something; running it proves the code does something, and only the second one differs between two commits in a way worth reporting.
- It must not write anywhere except a temporary path. The same probe file runs on both sides; if it edits itself the run is void.
- Use the token {probe} in args where the probe's own file path belongs.
- Set installPath only when the runner cannot load a file from outside the project.

If you cannot write a probe that would actually distinguish the two commits, submit an empty list. That is a real answer and it is reported honestly. A probe that passes on both sides regardless of the change is worse than no probe, because it looks like evidence.

Call ${PROBE_TOOL_NAME} exactly once, then stop.`;

const PROBE_MAX_TOKENS = 8_000;

const log = (message: string): void => console.error(`[verit-lane] ${message}`);

/**
 * How this repository runs things.
 *
 * Measured: five of twelve generated probes failed on both sides, and every one
 * of them was about behavior at run time rather than file contents. The writer
 * could describe what a command should do and had never been told the command
 * exists, so it asserted about the source of a CLI instead of running it. What
 * follows is the missing half.
 */
export interface RuntimeFacts {
  /** The repository's own verification commands, as it runs them. */
  readonly suites: readonly string[];
  /** How the probe itself is launched, so the writer knows its own footing. */
  readonly invocation: string;
  /** Directory the probe starts in, relative to the repository root. */
  readonly cwd: string;
}

/** The material the probe writer sees. Kept narrow on purpose. */
export interface ProbeContext {
  readonly claim: Claim;
  readonly netDiff: string;
  /** Repository facts a probe needs: layout, test runner, language. */
  readonly repoContext?: string;
  /** Tests the repository already has for this area, so it does not repeat one. */
  readonly existingTests?: readonly string[];
  readonly runtime?: RuntimeFacts;
}

export const renderProbeContext = (ctx: ProbeContext): string => {
  const parts: string[] = [`CLAIM:\n${ctx.claim.statement}`];
  if (ctx.claim.regions.length > 0) {
    parts.push(`REGIONS:\n${ctx.claim.regions.join("\n")}`);
  }
  if (ctx.repoContext !== undefined && ctx.repoContext !== "") {
    parts.push(`REPOSITORY:\n${ctx.repoContext}`);
  }
  if (ctx.existingTests !== undefined && ctx.existingTests.length > 0) {
    parts.push(
      `THE REPOSITORY ALREADY TESTS THESE, do not rewrite them:\n${ctx.existingTests.join("\n")}`,
    );
  }
  if (ctx.runtime !== undefined) {
    parts.push(
      [
        "HOW THIS REPOSITORY RUNS:",
        `  its own test commands: ${ctx.runtime.suites.join(" | ") || "(none detected)"}`,
        `  your probe is launched as: ${ctx.runtime.invocation}`,
        `  your working directory: ${ctx.runtime.cwd === "" ? "the repository root" : ctx.runtime.cwd}`,
        "  You may start processes. To check what a command does, run it and read its exit code and output, rather than asserting about the source that implements it.",
      ].join("\n"),
    );
  }
  parts.push(`NET DIFF:\n${ctx.netDiff}`);
  return parts.join("\n\n");
};

/**
 * One model call, then a decode. Never throws, and every failure path returns
 * no probes: a claim with no probe is needs-evidence, which is true, where an
 * invented probe would be evidence that measures nothing.
 */
export const runProbePass = async (
  client: LaneClient,
  ctx: ProbeContext,
): Promise<readonly GeneratedProbe[]> => {
  try {
    const request: LaneRequest = {
      system: PROBE_SYSTEM,
      messages: [{ role: "user", content: renderProbeContext(ctx) }],
      tools: [probeTool()],
      maxTokens: PROBE_MAX_TOKENS,
      forceTool: PROBE_TOOL_NAME,
    };
    const outcome = await Effect.runPromise(Effect.either(client.complete(request)));
    if (Either.isLeft(outcome)) {
      log(`probe pass failed, this claim gets no generated probe: ${outcome.left.message}`);
      return [];
    }
    const call = outcome.right.toolCalls.find((c) => c.name === PROBE_TOOL_NAME);
    if (call === undefined) {
      log("probe pass submitted no probe");
      return [];
    }
    const decoded = decodeProbeSubmission(call.input);
    if (Either.isLeft(decoded)) {
      log("probe pass output was invalid, this claim gets no generated probe");
      return [];
    }
    return decoded.right.probes;
  } catch (error) {
    log(`probe pass errored: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

/**
 * Everything a generated probe needs to become a runnable one, with its origin
 * fixed to `generated`.
 *
 * The origin is set here rather than taken from the model, so no output can
 * describe itself as one of the repository's own tests. Grading never reads it
 * either way; this keeps the record honest for the human reading the evidence.
 */
export const toProbeSpec = (
  p: GeneratedProbe,
  id: string,
  /**
   * Whether the behavior is absent on the base commit. Derived from the diff by
   * the caller, never asked of the model: asked, it answered yes eleven times
   * out of eleven, which is not a judgement.
   */
  kind: "behavioral" | "precondition" = "behavioral",
): {
  id: string;
  source: string;
  origin: "generated";
  kind: "behavioral" | "precondition";
  fileName: string;
  installPath?: string;
  command: string;
  args: readonly string[];
  asserts: string;
} => ({
  id,
  source: p.source,
  origin: "generated",
  kind,
  fileName: p.fileName,
  ...(p.installPath !== undefined && p.installPath !== "" ? { installPath: p.installPath } : {}),
  command: p.command,
  args: p.args,
  asserts: p.asserts,
});

/* -------------------------------------------------------------------------- */
/* One call for every claim, when the operator wants to trade attention for    */
/* cost.                                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Measured: twelve claims meant twelve calls, each carrying its own slice. The
 * obvious saving is to ask once. The obvious risk is that a writer holding
 * twelve problems writes twelve worse probes than a writer holding one.
 *
 * Neither is worth arguing about, so both exist and the run reports which it
 * used. The batch keeps the claim id on every probe, because a probe that
 * cannot be attributed back to a claim is a probe nobody can act on.
 */

export const PROBE_BATCH_TOOL_NAME = "submit_probes_for_claims";

const BatchEntry = S.Struct({
  /** The claim id, copied exactly from the material. */
  claimId: S.String.pipe(S.minLength(1)),
  probes: S.Array(GeneratedProbe),
});

export const ProbeBatchSubmission = S.Struct({
  entries: S.Array(BatchEntry),
});
export type ProbeBatchSubmission = S.Schema.Type<typeof ProbeBatchSubmission>;

const decodeProbeBatch = S.decodeUnknownEither(ProbeBatchSubmission);

export const probeBatchJsonSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(JSON.stringify(JSONSchema.make(ProbeBatchSubmission))) as Record<
    string,
    unknown
  >;
  delete schema["$schema"];
  return schema;
};

const probeBatchTool = (): LaneTool => ({
  name: PROBE_BATCH_TOOL_NAME,
  description:
    "Submit probes for every claim below, keyed by claim id. Call exactly once, then stop.",
  inputSchema: probeBatchJsonSchema(),
});

const BATCH_MAX_TOKENS = 24_000;

/**
 * One call, many claims.
 *
 * Failure is the same shape as the single path: no probes rather than invented
 * ones. A claim the model skips simply has none, which readiness reports as
 * needs-evidence, and that is a true statement about the run.
 */
export const runProbeBatch = async (
  client: LaneClient,
  contexts: readonly ProbeContext[],
): Promise<ReadonlyMap<string, readonly GeneratedProbe[]>> => {
  const empty = new Map<string, readonly GeneratedProbe[]>();
  if (contexts.length === 0) return empty;

  const user = contexts
    .map((ctx) => `===== CLAIM ${ctx.claim.id} =====\n${renderProbeContext(ctx)}`)
    .join("\n\n");

  try {
    const request: LaneRequest = {
      system: `${PROBE_SYSTEM}\n\nYou are given several claims at once, each under a "===== CLAIM <id> =====" header. Answer every one of them, and put each probe under the claim id it belongs to, copied exactly. A claim you cannot write a probe for gets an empty list, which is a real answer.`,
      messages: [{ role: "user", content: user }],
      tools: [probeBatchTool()],
      maxTokens: BATCH_MAX_TOKENS,
      forceTool: PROBE_BATCH_TOOL_NAME,
    };
    const outcome = await Effect.runPromise(Effect.either(client.complete(request)));
    if (Either.isLeft(outcome)) {
      log(`probe batch failed, this run has no generated probes: ${outcome.left.message}`);
      return empty;
    }
    const call = outcome.right.toolCalls.find((c) => c.name === PROBE_BATCH_TOOL_NAME);
    if (call === undefined) {
      log("probe batch submitted nothing");
      return empty;
    }
    const decoded = decodeProbeBatch(call.input);
    if (Either.isLeft(decoded)) {
      log("probe batch output was invalid, this run has no generated probes");
      return empty;
    }
    const known = new Set(contexts.map((c) => c.claim.id));
    const out = new Map<string, readonly GeneratedProbe[]>();
    for (const e of decoded.right.entries) {
      // A probe attributed to a claim nobody asked about belongs to nothing.
      if (!known.has(e.claimId)) {
        log(`probe batch named an unknown claim ${e.claimId}, dropped`);
        continue;
      }
      out.set(e.claimId, e.probes);
    }
    return out;
  } catch (error) {
    log(`probe batch errored: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
};
