# Cyclops Design System

Production design system for the Cyclops proof/review platform.

## Canonical sources

| Layer | Location |
|---|---|
| Tokens (JSON) | [`../tokens.json`](../tokens.json) |
| Tokens (CSS) | [`../tokens.css`](../tokens.css) |
| Visual library | [Paper: Cyclops Design System](https://app.paper.design/file/01KYYHRE1J0YJA5AWE9JCBG6MM) |
| Docs | this folder |

## Paper pages

| Page | Contents |
|---|---|
| Cover | Brand, principles |
| 01 Foundations | Spacing, radius, elevation, breakpoints, icons, layout columns (variables merged here) |
| 03 Typography | Full scale display→caption + mono |
| 04 Colors | Semantic light swatches + status AA |
| 05 Components | Atoms, molecules, organisms with variants/states |
| 06 Patterns | Empty, skeleton, form stack, nav shell + cmdk |
| 07 Templates | Proof report, review dashboard, PR dogfood (#415) |
| 08 Documentation | Principles, a11y, tokens, do/don't, research, Figma note, packages/web |

## Decisions

- **Product:** Cyclops first (generic “B” kit later as a fork)
- **Mood:** mineral, slate neutrals + oxidized-copper teal (`#0F766E`)
- **Type:** IBM Plex Sans + IBM Plex Mono
- **Theme:** light-first + `data-theme="dark"`
- **Structural laws** (from efe-design, not visuals): 4px spacing, WCAG floors, flat elevation, semantic triple-encoding, rank by weight before size
- **Nav active:** subtle fill + 2px teal spine
- **Research:** Mobbin-class patterns (Linear, Stripe, Vercel, GitHub). Synthesized, not copied

## Figma note

Figma sync pending (MCP flake this session). Paper hosts the visual library; `tokens.json` is Figma-importable when Variables MCP is stable. Sync checklist: [`figma-sync.md`](./figma-sync.md).

## Inventory

Atoms, molecules, organisms, and Cyclops proof blocks: [`inventory.md`](./inventory.md).

## packages/web

Import `design/tokens.css` at the app root. Treat the Paper file as the visual contract until React DS packages land. Control heights: button 36 · input 40 · row 44.
