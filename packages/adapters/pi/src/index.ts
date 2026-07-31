import type { HarnessPort } from "@cyclops/ports";
import { makeStubHarness } from "@cyclops/adapter-memory";

/**
 * Pi harness adapter seam.
 * When CYCLOPS_PI_BIN is set, future work will spawn pi-agent-core;
 * until then dogfood uses the deterministic stub (still produces Understanding).
 */
export const makePiHarness = (): HarnessPort => {
  if (process.env.CYCLOPS_PI_BIN) {
    // TODO: spawn Pi with compiled skill pack + ReviewContext
    return makeStubHarness();
  }
  return makeStubHarness();
};
