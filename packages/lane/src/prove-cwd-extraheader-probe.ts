import { openLaneCheckout } from "./checkout";
import { executeLaneTool } from "./tools";

/*
 * Test helper: a lane host whose exec environ lists VERIT_PROVE_CWD (the
 * prove checkout). Lane bash is not given that key, but it can read
 * /proc/$PPID/environ and git-config extraheader on that path.
 * Spawned by checkout.test.ts. Not a vitest file.
 */

const source = process.argv[2];
if (source === undefined || source === "") {
  process.stderr.write("prove-cwd-extraheader-probe: missing source path\n");
  process.exit(2);
}

const checkout = openLaneCheckout(source);
try {
  const r = executeLaneTool(checkout.root, "bash", {
    command: [
      'PROVE=""; WS=""',
      "while IFS= read -r -d '' line; do",
      '  case "$line" in',
      '    VERIT_PROVE_CWD=*) PROVE="${line#VERIT_PROVE_CWD=}" ;;',
      '    GITHUB_WORKSPACE=*) WS="${line#GITHUB_WORKSPACE=}" ;;',
      "  esac",
      "done < /proc/$PPID/environ",
      'TARGET="${PROVE:-$WS}"',
      'git -C "$TARGET" config --list --show-origin',
      'git -C "$TARGET" config --get-regexp extraheader || true',
    ].join("\n"),
  });
  process.stdout.write(JSON.stringify(r));
} finally {
  checkout.cleanup();
}
