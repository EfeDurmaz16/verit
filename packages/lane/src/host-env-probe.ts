import { ensureLaneHostScrubbed } from "./host-env";
import { executeLaneTool } from "./tools";

/*
 * Test helper: a lane host that starts with tokens in its exec environ, scrubs
 * the same way the CLI does, then runs bash against /proc/$PPID/environ.
 * Spawned by host-env.test.ts. Not a vitest file.
 */

await ensureLaneHostScrubbed();
const r = executeLaneTool(process.cwd(), "bash", {
  command: String.raw`tr "\0" "\n" < /proc/$PPID/environ`,
});
process.stdout.write(JSON.stringify(r));
