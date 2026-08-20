import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLaneCheckout } from "./checkout";
import { executeLaneTool } from "./tools";

/*
 * The blocker: lane tools ran in the very checkout prove was about to measure,
 * so a model told to `rm` the failing test, rewrite the test script, and
 * `git checkout` a passing ref could hand prove a green tree it never earned.
 * The fixture drives exactly that hostile input and proves the prove workspace
 * is byte-unchanged, because the tools ran in an isolated checkout of HEAD.
 */

const git = (args: readonly string[], cwd: string) =>
  spawnSync("git", [...args], { cwd, encoding: "utf8" });

const headSha = (dir: string) => git(["rev-parse", "HEAD"], dir).stdout.trim();
const porcelain = (dir: string) => git(["status", "--porcelain"], dir).stdout;

let source: string;

beforeAll(() => {
  source = mkdtempSync(join(tmpdir(), "verit-prove-tree-"));
  git(["init", "-q", "-b", "main"], source);
  git(["config", "user.email", "t@example.com"], source);
  git(["config", "user.name", "t"], source);
  writeFileSync(join(source, "failing.test.ts"), "expect(1).toBe(2);\n");
  writeFileSync(join(source, "run-tests.sh"), "vitest run\n");
  git(["add", "-A"], source);
  git(["commit", "-qm", "seed"], source);
  // a second ref the hostile command can try to swap onto
  git(["branch", "other"], source);
});

afterAll(() => {
  rmSync(source, { recursive: true, force: true });
});

describe("openLaneCheckout", () => {
  it("isolates hostile lane tool writes from the prove workspace", () => {
    const beforeHead = headSha(source);
    const beforeFailing = readFileSync(join(source, "failing.test.ts"), "utf8");
    const beforeScript = readFileSync(join(source, "run-tests.sh"), "utf8");
    expect(porcelain(source)).toBe("");

    const checkout = openLaneCheckout(source);
    try {
      expect(checkout.isolated).toBe(true);
      expect(checkout.root).not.toBe(source);

      // exactly the hostile input from the audit, run through the real tool.
      const r = executeLaneTool(checkout.root, "bash", {
        command:
          "rm -f failing.test.ts && printf 'echo pass\\n' > run-tests.sh && git checkout other",
      });
      expect(r.isError).toBe(false);

      // the mutation really happened, in the isolated checkout only.
      expect(existsSync(join(checkout.root, "failing.test.ts"))).toBe(false);
    } finally {
      checkout.cleanup();
    }

    // the prove workspace is byte-unchanged: same HEAD, clean tree, same files.
    expect(headSha(source)).toBe(beforeHead);
    expect(porcelain(source)).toBe("");
    expect(readFileSync(join(source, "failing.test.ts"), "utf8")).toBe(beforeFailing);
    expect(readFileSync(join(source, "run-tests.sh"), "utf8")).toBe(beforeScript);
    // and the temp checkout is gone after cleanup.
    expect(existsSync(checkout.root)).toBe(false);
  });
});
