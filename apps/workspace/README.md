# Lattice

A task workspace over GitHub pull requests. Instead of rendering the PR page, Lattice renders what you are trying to do: review the change.

Open a PR URL and a structural shell appears instantly (files, CI, timeline — straight from the GitHub API). A real coding agent (Codex CLI) then reads the full diff, the review threads, and the failing CI logs, and **builds the interface itself**: it streams [json-render](https://json-render.dev) SpecStream patches (RFC 6902, one JSON patch per line) that progressively assemble an executive summary, a dependency-aware review order, risk clusters, an architecture graph, evidence-linked insights, and verdict-style next steps. Every insight cites verbatim excerpts from the diff.

The command bar resumes the same agent session: "why is CI failing?", "focus on security" — the agent answers and re-patches the workspace, reordering sections and refocusing content.

## Architecture

```
GitHub (gh CLI)          Codex CLI (headless)
      │                        │
      │ structural facts       │ codex exec --json, sandboxed, network on
      ▼                        ▼
/api/pr  /api/analyze ── spawns agent, tails blocks.ndjson (SpecStream JSONL)
      │                        │
      └────── SSE: patch / activity / answer / session ──────┐
                                                             ▼
                              client: applySpecPatch → <Renderer registry>
```

- `lib/catalog.ts` — the component catalog (Zod-validated). `catalog.prompt()` becomes the agent's system prompt; the renderer refuses anything not registered.
- `lib/shell-spec.ts` — instant workspace shell from GitHub data, before any AI.
- `lib/codex.ts` — spawns `codex exec`, multiplexes agent activity + spec patches into SSE.
- `app/api/command/route.ts` — `codex exec resume <thread>` for command-bar turns.
- `components/registry.tsx` — the 20 renderers (Section, Insight, RiskCluster, ArchGraph, CompatMatrix, CodePreview, …). AI props are treated as untrusted input and validated defensively.
- Demo mode (no PR loaded) replays the mock dataset through the exact same SpecStream pipeline.

## Run

```bash
bun install
bun run dev
```

Requirements: `gh` (authenticated) and `codex` CLI on PATH. Without them the demo workspace still works; live analysis needs both.

## Notes

- The agent works in a throwaway temp dir with codex's `workspace-write` sandbox; network access is enabled so it can call `gh`.
- Malformed patches from the model are dropped, never crash the workspace.
- ponytail: single-process session map (temp dirs + thread ids live per dev-server); multi-user deployment needs a session store.
