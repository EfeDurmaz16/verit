"use client";

import { createContext, useContext, type ReactNode } from "react";

export type Focus = "all" | "security" | "protocol" | "risk";

export interface Selection {
  kind: "file" | "insight" | "risk" | "node" | "check" | "step";
  payload: Record<string, unknown>;
}

/**
 * Everything the proof registry needs from the app around it. The live
 * workspace wires this to its streaming store. The dashboard renders a stored
 * spec and leaves the defaults in place, so the same components read as a
 * static page there without a second copy of them.
 */
export interface ProofUiHost {
  /** "streaming" makes an empty Section render its pending state. */
  readonly status: "idle" | "fetching" | "streaming" | "ready" | "error";
  readonly selection: Selection | null;
  /** Paths to flash after a click. */
  readonly highlight: readonly string[];
  readonly focus: Focus;
  readonly proveBusy: boolean;
  readonly select: (s: Selection | null) => void;
  readonly flashFiles: (paths: string[]) => void;
  readonly prove: () => void;
}

const READ_ONLY: ProofUiHost = {
  status: "ready",
  selection: null,
  highlight: [],
  focus: "all",
  proveBusy: false,
  select: () => {},
  flashFiles: () => {},
  prove: () => {},
};

const Ctx = createContext<ProofUiHost>(READ_ONLY);

export function ProofUiProvider({ host, children }: { host: ProofUiHost; children: ReactNode }) {
  return <Ctx.Provider value={host}>{children}</Ctx.Provider>;
}

export const useProofUi = (): ProofUiHost => useContext(Ctx);
