import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/*
 * The regression these tests exist for.
 *
 * prove refuses to run a repository's test command under a privileged event.
 * That guard is real, and it is also too late: the composite action installed
 * the reviewed repository's dependencies first, in GITHUB_WORKSPACE, and a
 * postinstall script is a shell script the pull request author chose. Under
 * pull_request_target that script runs beside a write-scoped token and the
 * repository's secrets, and prove never gets a say.
 *
 * So the decision moved to the first step of the action, and every step that
 * can execute repository code is gated on it. These tests assert the real
 * ordering in the real file, and run the real gate script against a real
 * malicious postinstall, because a comment claiming an ordering is not one.
 */

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "action.yml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root with action.yml not found");
};

const actionYml = readFileSync(join(repoRoot(), "action.yml"), "utf8");

/** The one composite step containing `anchor`, from its `- ` to the next `- `. */
const stepAround = (anchor: string): string => {
  const at = actionYml.indexOf(anchor);
  if (at < 0) return "";
  const start = actionYml.lastIndexOf("\n    - ", at);
  let end = actionYml.indexOf("\n    - ", at + anchor.length);
  if (end < 0) end = actionYml.length;
  return actionYml.slice(start, end);
};

const indexOfStep = (anchor: string): number => {
  const at = actionYml.indexOf(anchor);
  return at < 0 ? Number.POSITIVE_INFINITY : at;
};

/** The gate step's shell body, dedented so bash can run it as written. */
const gateScript = (): string => {
  const step = stepAround("id: gate");
  const at = step.indexOf("run: |");
  expect(at).toBeGreaterThan(-1);
  const body = step.slice(at + "run: |".length);
  return body
    .split("\n")
    .map((l) => (l.startsWith("        ") ? l.slice(8) : l))
    .join("\n");
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the real gate script for one event and read what it decided. */
const runGate = (event: string): { safe: string; reason: string } => {
  const dir = mkdtempSync(join(tmpdir(), "verit-gate-"));
  dirs.push(dir);
  const outFile = join(dir, "github_output");
  writeFileSync(outFile, "");
  const script = join(dir, "gate.sh");
  writeFileSync(script, gateScript());
  execFileSync("bash", [script], {
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: outFile },
    encoding: "utf8",
  });
  const out = readFileSync(outFile, "utf8");
  const safe = /^safe=(.*)$/m.exec(out)?.[1] ?? "";
  const reason = out.includes("reason<<VERIT_EOF")
    ? (out.split("reason<<VERIT_EOF\n")[1]?.split("\nVERIT_EOF")[0] ?? "")
    : (/^reason=(.*)$/m.exec(out)?.[1] ?? "");
  return { safe, reason };
};

const PRIVILEGED = ["pull_request_target", "workflow_run", "issue_comment"];
const ORDINARY = ["pull_request", "push", "schedule", "workflow_dispatch"];

describe("the gate decides before anything can run repository code", () => {
  it("is the first step in the composite action", () => {
    const gate = indexOfStep("id: gate");
    for (const later of [
      "actions/setup-node@v4",
      "Install pnpm",
      "Install verit",
      "Install the reviewed repo's dependencies",
      "Review, prove and post the Check",
    ]) {
      expect(gate).toBeLessThan(indexOfStep(later));
    }
  });

  it("gates the step that installs the reviewed repository's dependencies", () => {
    const step = stepAround("Install the reviewed repo's dependencies");
    expect(step).toContain("steps.gate.outputs.safe == 'true'");
    // and that step is still the one that runs the caller's command in the
    // reviewed workspace, so the condition is guarding the real hole
    expect(step).toContain("github.workspace");
    expect(step).toContain("$INSTALL_COMMAND");
  });

  it("gates the review and prove step", () => {
    const step = stepAround("Review, prove and post the Check");
    expect(step).toContain("steps.gate.outputs.safe == 'true'");
  });

  it("gates every step that names the reviewed workspace or runs the review", () => {
    // Whole-file sweep, so a step added later cannot quietly skip the gate.
    const steps = actionYml.split("\n    - ").slice(1);
    for (const step of steps) {
      const touchesWorkspace = step.includes("github.workspace");
      const runsReview = step.includes("main.ts dogfood");
      const runsInstall = step.includes("$INSTALL_COMMAND");
      if (touchesWorkspace || runsReview || runsInstall) {
        expect(step).toContain("steps.gate.outputs.safe == 'true'");
      }
    }
  });

  it("publishes the refusal from verit's own checkout, never the reviewed one", () => {
    const step = stepAround("Publish the refusal");
    expect(step).toContain("steps.gate.outputs.safe != 'true'");
    expect(step).toContain("github.action_path");
    expect(step).not.toContain("github.workspace");
    expect(step).toContain("main.ts refuse");
  });
});

describe("the real gate script, run as written", () => {
  for (const event of PRIVILEGED) {
    it(`declines ${event}`, () => {
      const out = runGate(event);
      expect(out.safe).toBe("false");
      expect(out.reason).toContain(event);
      expect(out.reason).toContain("on: pull_request");
    });
  }
  for (const event of ORDINARY) {
    it(`allows ${event}`, () => {
      expect(runGate(event).safe).toBe("true");
    });
  }
  it("allows a run with no event name rather than wedging", () => {
    const dir = mkdtempSync(join(tmpdir(), "verit-gate-"));
    dirs.push(dir);
    const outFile = join(dir, "github_output");
    writeFileSync(outFile, "");
    const script = join(dir, "gate.sh");
    writeFileSync(script, gateScript());
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: outFile };
    delete env.GITHUB_EVENT_NAME;
    execFileSync("bash", [script], { env, encoding: "utf8" });
    expect(readFileSync(outFile, "utf8")).toContain("safe=true");
  });
});

describe("a malicious postinstall never runs under a privileged event", () => {
  /**
   * The composite action, reduced to the two things that matter: the gate
   * decides, and the install of the reviewed repository's dependencies runs
   * only when it said yes. The reviewed repository here is hostile in the
   * ordinary way, with a lifecycle script, which is all it takes.
   */
  const simulateAction = (event: string): { sentinelWritten: boolean } => {
    const workspace = mkdtempSync(join(tmpdir(), "verit-hostile-repo-"));
    dirs.push(workspace);
    const sentinel = join(workspace, "pwned.txt");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "hostile",
        scripts: { postinstall: `node -e "require('fs').writeFileSync('${sentinel}','pwned')"` },
      }),
    );

    const gateDir = mkdtempSync(join(tmpdir(), "verit-gate-"));
    dirs.push(gateDir);
    const outFile = join(gateDir, "github_output");
    writeFileSync(outFile, "");
    const gate = join(gateDir, "gate.sh");
    writeFileSync(gate, gateScript());
    execFileSync("bash", [gate], {
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: outFile },
      encoding: "utf8",
    });
    const safe = /^safe=(.*)$/m.exec(readFileSync(outFile, "utf8"))?.[1] ?? "";

    if (safe === "true") {
      // exactly what the gated step does: run the caller's install command in
      // the reviewed workspace, which triggers the lifecycle script
      execFileSync("npm", ["run", "postinstall"], { cwd: workspace, encoding: "utf8" });
    }
    return { sentinelWritten: existsSync(sentinel) };
  };

  for (const event of PRIVILEGED) {
    it(`does not execute the lifecycle script under ${event}`, () => {
      expect(simulateAction(event).sentinelWritten).toBe(false);
    }, 30_000);
  }

  it("does execute it under pull_request, which is the product working", () => {
    expect(simulateAction("pull_request").sentinelWritten).toBe(true);
  }, 30_000);
});
