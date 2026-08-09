# @cyclops/workspace

The live review workspace: the face of cyclops. Open a PR URL and a structural
shell appears instantly (files, CI, timeline — straight from the GitHub API).
One analysis lane (Codex CLI, headless) then reads the full diff, the review
threads and the failing CI logs, and **builds the interface itself**: it streams
[json-render](https://json-render.dev) SpecStream patches (RFC 6902, one JSON
patch per line) into the Understanding surfaces.

The lane's real output contract is `understanding.json`. It is validated against
the cyclops `Understanding` schema (Effect Schema, `@cyclops/domain`) before
anything canonical is rendered or stored. A run that fails validation is shown
as unverified rather than dressed up as a review.

```
GitHub (gh CLI)          Codex CLI (headless)
      │                        │
      │ structural facts       │ codex exec --json, sandboxed, network on
      ▼                        ▼
/api/pr  /api/analyze ── spawns the lane, tails blocks.ndjson (SpecStream JSONL)
      │                        │
      │                        └── understanding.json ── Effect Schema ──┐
      │                                                                   ▼
      │                                        runReviewUnderstand → ReviewRun row
      │                                        + Understanding JSON + proof spec
      └────── SSE: patch / activity / answer / session ──────┐
                                                             ▼
                              client: applySpecPatch → <Renderer registry>
```

## Layout

- `lib/catalog.ts` — the component catalog (Zod-validated). `catalog.prompt()`
  becomes the lane's system prompt; the renderer refuses anything not registered.
- `lib/shell-spec.ts` — instant shell from GitHub data, before any AI. Its
  section slots are the Understanding fields, in the locked proof-page order.
- `lib/prompt.ts` — the single `understand` lane prompt and its output contract.
- `lib/understanding.ts` — schema validation plus the deterministic render of a
  validated Understanding.
- `lib/sessions.ts` — detached sessions: rows in the `SessionStore`, blobs under
  `.data/workspace/<session>/`, only the live listener set in memory.
- `lib/review-run.ts` — hands the lane's Understanding to `runReviewUnderstand`
  as a `HarnessPort`. Swapping Codex for Pi is swapping that one adapter.
- `components/registry.tsx` — the renderers. AI props are untrusted input and
  are validated defensively.

## Run

```bash
pnpm install
pnpm workspace          # from the repo root, http://localhost:3000
```

Requires `gh` (authenticated) and `codex` on PATH. Without them the demo
workspace still renders; live analysis needs both.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `CYCLOPS_SQLITE_PATH` | `.data/cyclops.db` | Sessions, runs, Understandings |
| `CYCLOPS_WORKSPACE_DIR` | `.data/workspace` | Per-session blob directories |
| `CYCLOPS_LANE_MODEL` | unset | Model passed to `codex exec -m` |

## Notes

- The lane works in its session directory under codex's `workspace-write`
  sandbox; network access is on so it can call `gh` if it must.
- Malformed patches from the model are dropped, never crash the workspace.
- A finished run replays from the store: same PR head and prompt version means
  no second analysis, and no lost work across a server restart.
