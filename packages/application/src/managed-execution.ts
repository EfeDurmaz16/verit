import { createHash } from "node:crypto";
import type { ExecutionMemoryRecord, ExecutionPolicy } from "@verit/domain";
import type { ProveCommand } from "@verit/ports";

/*
 * Running a repository without being told how.
 *
 * The contract says a maintainer installs verit and gets evidence, without
 * writing a sandbox recipe and without writing a probe. So every input this
 * needs is either detected from the repository, remembered from a run that
 * already worked, or defaulted, and the only time a human is asked for anything
 * is when the repository genuinely has no way to verify itself.
 *
 * Remembering is what makes the second run cheap. An install command that
 * worked for this dependency set before is tried again before anything is
 * guessed, which is the execution memory earning its keep.
 */

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** How the two sides are scheduled. Identical on both, by definition. */
export const ORCHESTRATION = "one probe, base and head, own worktree each, repeats per side";

/** Where it runs. Named so the digest changes when the isolation changes. */
export type IsolationKind = "runner-ephemeral" | "managed-ephemeral" | "local";

export interface ManagedExecution {
  readonly policy: ExecutionPolicy;
  /** What to run before the probe on each side, or null when nothing is needed. */
  readonly prepare: ProveCommand | null;
  /** Where `prepare` came from, for the evidence body. */
  readonly prepareSource: "remembered" | "detected" | "none";
  /** Repeats per side. Raised when this repository has flaked before. */
  readonly runsPerSide: number;
  /**
   * Set when the repository gives verit nothing to work with. This is the only
   * case that asks a human for anything, and it names what is missing rather
   * than asking them to configure a sandbox.
   */
  readonly needsMaintainerInput: string | null;
}

/** Install commands per manifest, in the order a repository usually wants them. */
const DETECTED_INSTALLS: ReadonlyArray<{ manifest: string; command: string; args: string[] }> = [
  { manifest: "pnpm-lock.yaml", command: "pnpm", args: ["install", "--frozen-lockfile"] },
  { manifest: "yarn.lock", command: "yarn", args: ["install", "--immutable"] },
  { manifest: "package-lock.json", command: "npm", args: ["ci"] },
  { manifest: "bun.lockb", command: "bun", args: ["install", "--frozen-lockfile"] },
  { manifest: "package.json", command: "npm", args: ["install"] },
  { manifest: "uv.lock", command: "uv", args: ["sync", "--frozen"] },
  { manifest: "poetry.lock", command: "poetry", args: ["install", "--no-interaction"] },
  { manifest: "requirements.txt", command: "pip", args: ["install", "-r", "requirements.txt"] },
  { manifest: "go.sum", command: "go", args: ["mod", "download"] },
  { manifest: "Gemfile.lock", command: "bundle", args: ["install"] },
  { manifest: "composer.lock", command: "composer", args: ["install", "--no-interaction"] },
];

/** Split a remembered command back into argv. It was stored as it was run. */
const parseRemembered = (command: string): ProveCommand | null => {
  const parts = command.trim().split(/\s+/).filter((p) => p !== "");
  const head = parts[0];
  if (head === undefined) return null;
  return { command: head, args: parts.slice(1), source: "execution memory" };
};

/**
 * A repository that flaked before gets more repeats, because the cost of a
 * wrong regression is far higher than the cost of running a probe twice more.
 */
export const repeatsFor = (history: { runs: number; unstable: number } | null): number => {
  if (history === null || history.runs === 0) return 2;
  const rate = history.unstable / history.runs;
  if (rate >= 0.5) return 5;
  if (rate > 0) return 3;
  return 2;
};

export const resolveManagedExecution = (input: {
  /** Manifests present in the repository, repo-relative. */
  readonly repoFiles: readonly string[];
  /** What prove detected as the repository's own verification suites. */
  readonly detectedSuites: readonly ProveCommand[];
  /** A previous install that worked for this dependency set, if any. */
  readonly rememberedInstall?: ExecutionMemoryRecord | null;
  /** How often this repository's probes disagreed with themselves before. */
  readonly stabilityHistory?: { runs: number; unstable: number } | null;
  readonly isolation?: IsolationKind;
  /** An install the maintainer named. It wins: they know their repository. */
  readonly overrideInstall?: ProveCommand | null;
}): ManagedExecution => {
  const isolation: IsolationKind = input.isolation ?? "runner-ephemeral";
  const files = new Set(input.repoFiles.map((f) => f.replace(/\\/g, "/")));

  let prepare: ProveCommand | null = null;
  let prepareSource: ManagedExecution["prepareSource"] = "none";

  if (input.overrideInstall != null) {
    prepare = input.overrideInstall;
    prepareSource = "detected";
  } else if (input.rememberedInstall != null && input.rememberedInstall.installCommand !== "") {
    // A command that already worked on this dependency set beats a guess.
    prepare = parseRemembered(input.rememberedInstall.installCommand);
    prepareSource = prepare === null ? "none" : "remembered";
  }

  if (prepare === null) {
    const found = DETECTED_INSTALLS.find((d) => files.has(d.manifest));
    if (found !== undefined) {
      prepare = { command: found.command, args: found.args, source: found.manifest };
      prepareSource = "detected";
    }
  }

  const runsPerSide = repeatsFor(input.stabilityHistory ?? null);

  // The one thing that cannot be defaulted: a repository that verifies nothing
  // cannot be measured. Say what is missing, do not ask for a sandbox recipe.
  const needsMaintainerInput =
    input.detectedSuites.length === 0
      ? "verit found no way this repository verifies itself: no test script, no test target, no suite in any manifest it read. Point it at one with prove-command, or add a test script."
      : null;

  const digest = sha256(
    [
      ORCHESTRATION,
      isolation,
      `prepare=${prepare === null ? "none" : [prepare.command, ...prepare.args].join(" ")}`,
      `runs=${runsPerSide}`,
    ].join("\n"),
  );

  return {
    policy: { orchestration: ORCHESTRATION, isolation, digest },
    prepare,
    prepareSource,
    runsPerSide,
    needsMaintainerInput,
  };
};
