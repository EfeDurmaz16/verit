import {
  assertDomainFocus,
  CODING_SKILLS,
  OUTPUT_STYLE,
  REVIEW_SKILLS,
  type ReviewPresets,
} from "@cyclops/domain";
import type { CompilerPort } from "@cyclops/ports";
import { contentHash } from "./hash";

const skillBlock = (id: string, path: string, extra = ""): string =>
  `[[skills]]\nid = "${id}"\npath = "${path}"\n${extra}`.trimEnd();

export const compileReviewPack = (presets: ReviewPresets): ReturnType<CompilerPort["compileReviewPack"]> => {
  assertDomainFocus(presets.domain, presets.focus);
  const append = [
    `role=review`,
    `reviewer_identity=${presets.reviewer_identity}`,
    `proof_frequency=${presets.proof_frequency}`,
    `inline_comments=${presets.inline_comments}`,
    `domain=${presets.domain}`,
    presets.focus ? `focus=${presets.focus}` : `focus=none`,
    `# additive overlays: domain.${presets.domain} + focus.${presets.focus ?? "none"}`,
    ``,
    OUTPUT_STYLE,
  ].join("\n");

  const skillsToml = [
    `# GENERATED. Change presets instead.`,
    `[defaults]`,
    `agent_model_env = "BYOK_MODEL"`,
    `proof = "${presets.proof_frequency}"`,
    `min_confidence_inline = ${presets.inline_comments === "high_conf_only" ? "0.85" : "1.0"}`,
    ``,
    `[identity]`,
    `tone = "${presets.reviewer_identity}"`,
    ``,
    ...REVIEW_SKILLS.map((id) =>
      skillBlock(id, `skills/${id}/SKILL.md`, id === "post" ? `on = ["pull_request"]` : `on = ["pull_request", "local_diff"]`),
    ),
    ``,
    `[append]`,
    `text = """`,
    append,
    `"""`,
  ].join("\n");

  const skillPackHash = contentHash(skillsToml, 64);
  return { skillsToml, skillPackHash, append };
};

export const compileCodingPack = (presets: Pick<ReviewPresets, "reviewer_identity" | "domain" | "focus">) => {
  assertDomainFocus(presets.domain, presets.focus);
  const append = `role=implement\ndomain=${presets.domain}\nfocus=${presets.focus ?? "none"}\n\n${OUTPUT_STYLE}`;
  const skillsToml = [
    `# GENERATED coding pack`,
    ...CODING_SKILLS.map((id) => skillBlock(id, `skills/${id}/SKILL.md`)),
    `[append]`,
    `text = """`,
    append,
    `"""`,
  ].join("\n");
  const skillPackHash = contentHash(skillsToml, 64);
  return { skillsToml, skillPackHash, append };
};
