import { describe, expect, it } from "vitest";
import { classifyAssertion, describeAssertion, readsRatherThanRuns } from "./assertion-kind";

/*
 * The fixtures are probe shapes, not toys. Each one is close to something a
 * writer actually produced on the measured run, because the question this
 * answers is which of eleven fix-confirmed results were about behavior and
 * which were about the text of a file.
 */

describe("a probe that runs the thing is behavior", () => {
  it("counts a spawned process", () => {
    const src = `
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["packages/cli/src/main.ts", "refuse"], { encoding: "utf8" });
process.exit(r.status === 2 ? 0 : 1);
`;
    expect(classifyAssertion(src)).toBe("behavior");
  });

  it("counts importing the module under test and calling it", () => {
    const src = `
import { parse } from "./src/parse.ts";
try { parse("{a:1,}"); process.exit(0); } catch { process.exit(1); }
`;
    expect(classifyAssertion(src)).toBe("behavior");
  });

  it("counts a dynamic import of repository code", () => {
    const src = `const m = await import("./src/gate.js"); process.exit(m.decide("push") ? 0 : 1);`;
    expect(classifyAssertion(src)).toBe("behavior");
  });
});

describe("a probe that only reads a file is text", () => {
  it("catches the shape that looks like evidence and is not", () => {
    // fails on base and passes on head, and shows only that the file changed
    const src = `
import { readFileSync } from "node:fs";
const yml = readFileSync("action.yml", "utf8");
process.exit(yml.includes("id: gate") ? 0 : 1);
`;
    expect(classifyAssertion(src)).toBe("text");
    expect(readsRatherThanRuns(classifyAssertion(src))).toBe(true);
  });

  it("catches a regex over a file", () => {
    const src = `
import { readFileSync } from "node:fs";
const s = readFileSync("action.yml", "utf8");
process.exit(new RegExp("safe=false").test(s) ? 0 : 1);
`;
    expect(classifyAssertion(src)).toBe("text");
  });
});

describe("running the code and reading its output is mixed, not text", () => {
  it("does not demote a probe that greps what it ran", () => {
    const src = `
import { spawnSync } from "node:child_process";
const r = spawnSync("bash", ["gate.sh"], { encoding: "utf8" });
process.exit(r.stdout.includes("safe=false") ? 0 : 1);
`;
    const kind = classifyAssertion(src);
    expect(kind).toBe("mixed");
    // the code under test ran, so this is not the shape we are warning about
    expect(readsRatherThanRuns(kind)).toBe(false);
  });
});

describe("a probe with neither signal is unknown, and says so", () => {
  it("does not pretend to know", () => {
    expect(classifyAssertion("process.exit(0);")).toBe("unknown");
  });

  it("treats an empty probe as unknown rather than behavior", () => {
    expect(classifyAssertion("   ")).toBe("unknown");
  });
});

describe("the reader is told in their own language", () => {
  it("says what a text check does and does not show", () => {
    const line = describeAssertion("text");
    expect(line).toContain("read the file rather than running it");
    expect(line).toContain("not that behavior did");
  });

  it("has a line for every kind", () => {
    for (const kind of ["behavior", "text", "mixed", "unknown"] as const) {
      expect(describeAssertion(kind).length).toBeGreaterThan(10);
    }
  });
});

describe("shell probes, which is what the writer actually produces", () => {
  // both fixtures are trimmed from probes a real run generated
  const extractsAndRuns = `#!/usr/bin/env bash
set -euo pipefail
awk '/id: gate/,/^$/' action.yml > /tmp/gate.sh
(GITHUB_EVENT_NAME="$event" GITHUB_OUTPUT="$out" bash /tmp/gate.sh) || true
grep -m1 '^safe=' "$out"`;

  it("does not call a script that runs the extracted code unknown", () => {
    const kind = classifyAssertion(extractsAndRuns);
    expect(kind).toBe("mixed");
    expect(readsRatherThanRuns(kind)).toBe(false);
  });

  it("still calls a pure grep over a file text", () => {
    const src = `#!/usr/bin/env bash\nif ! grep -q "id: gate" action.yml; then exit 1; fi\nexit 0`;
    expect(classifyAssertion(src)).toBe("text");
  });

  it("counts running the package manager as behavior", () => {
    expect(classifyAssertion("#!/bin/sh\npnpm run test --filter cli\n")).toBe("behavior");
  });

  it("does not let a word in a comment promote a text probe", () => {
    // "go" and "make" read as prose here, not as commands
    const src = `const fs = require("fs");\n// we go through the file and make sure the line is there\nprocess.exit(fs.readFileSync("a.yml","utf8").includes("gate") ? 0 : 1);`;
    expect(classifyAssertion(src)).toBe("text");
  });
});
