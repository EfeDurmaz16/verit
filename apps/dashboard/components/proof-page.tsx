"use client";

import { registry } from "@verit/proof-ui";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";

/**
 * The stored proof spec, rendered with the same registry the live workspace
 * uses. No provider is wired around it: the registry's host context defaults
 * to read-only, which is exactly what a finished run is.
 */
export function ProofPage({ spec }: { spec: Spec }) {
  if (!spec.root || !spec.elements[spec.root]) {
    return (
      <p className="text-[12px] text-ink-3">This run has no proof spec to render.</p>
    );
  }
  return (
    <JSONUIProvider registry={registry}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
