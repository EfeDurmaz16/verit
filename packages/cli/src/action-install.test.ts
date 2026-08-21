import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * The audited launch blocker: the composite action installed only verit, in
 * github.action_path, and never the reviewed repo's dependencies. So a healthy
 * JS PR whose tests need node_modules got a false prove failure. The fix is an
 * install-command step that runs in github.workspace, the same tree prove runs
 * in, BEFORE the review step. This test pins that wiring so it cannot regress.
 */

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "action.yml"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
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

describe("install-command runs in the workspace, before prove", () => {
  it("declares an install-command input", () => {
    expect(actionYml).toMatch(/^ {2}install-command:\n\s+description:/m);
  });

  it("installs the reviewed repo in github.workspace, never github.action_path", () => {
    const step = stepAround("inputs.install-command != ''");
    expect(step, "install step gated on install-command not found").not.toBe("");
    // The crux of the bug fix: the caller's deps install in github.workspace,
    // the tree prove measures, not in verit's own checkout (github.action_path).
    expect(step).toMatch(/working-directory:\s*\$\{\{\s*github\.workspace\s*\}\}/);
    expect(step).not.toContain("github.action_path");
  });

  it("runs the install step before prove, and points prove at the same workspace", () => {
    const idxInstall = actionYml.indexOf("inputs.install-command != ''");
    const idxProve = actionYml.indexOf("main.ts dogfood");
    expect(idxInstall).toBeGreaterThan(-1);
    expect(idxProve).toBeGreaterThan(idxInstall);
    expect(actionYml).toMatch(/VERIT_PROVE_CWD:\s*\$\{\{\s*github\.workspace\s*\}\}/);
  });

  it("passes the command through env, so a workflow input cannot inject shell", () => {
    const step = stepAround("inputs.install-command != ''");
    expect(step).toMatch(/INSTALL_COMMAND:\s*\$\{\{\s*inputs\.install-command\s*\}\}/);
  });
});
