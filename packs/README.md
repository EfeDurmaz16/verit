# Compiler fixtures (golden)

Locked planning fixtures for the **pure** preset → pack compiler (no LLM inside compile).

Canonical write-up: [`../00-proposed-dual-agent.md`](../00-proposed-dual-agent.md) §7 · map Decision **AH** · issue [03](../../../.scratch/greptile-horizon/issues/03-preset-skills-compiler.md).

## Pure function

```text
presets.json  --pure function-->  coding.skills.toml + review.skills.toml
                                  (+ APPEND overlays: role · tone · domain · focus)
```

- **No LLM in the compiler.** Domain/focus **classifier** is a separate gate *before* compile (Decision 25 / AC).
- Skill **bodies** live in a shared catalog (`skills/<verb>/SKILL.md`); pack manifests only **reference** paths (Decision 24 / AB).
- Output is content-addressed as `skill_pack_hash` (sha256 of normalized emitted manifests + APPEND overlays) and stored on the proof report for replay.

## Role APPEND

One shared `understand` skill. Compiler injects role via APPEND:

| Pack | APPEND on `understand` |
| --- | --- |
| `coding.skills.toml` | `role=implement` |
| `review.skills.toml` | `role=review` |

Domain + optional focus APPEND texts concatenate after role (additive; no 22×22 packs). Same ≤6 verbs either way.

## Files here

| File | Role |
| --- | --- |
| [`presets.json`](presets.json) | Example v0 radios (identity, proof_frequency, automation, inline, domain, focus) |
| [`coding.skills.toml`](coding.skills.toml) | Example emitted coding pack (6 verbs) |
| [`review.skills.toml`](review.skills.toml) | Example emitted review pack (6 verbs + domain/focus APPEND) |

**Fixture landed; compiler implementation still open** (product code out of scope for this planning repo).
