# Principles

1. **Neutral by default, teal by exception.** Saturation marks primary action, active nav, or live state only.
2. **Rank by weight and color before size.** Page titles may grow; most hierarchy is 400/500/600 + muted text.
3. **Group with air, then a hairline.** Boxes only when the element is a discrete interactive unit.
4. **Elevation is earned.** Flat lists and tables; shadow only for popover, dialog, command palette.
5. **Proof reading is calm; run lists are dense.** Reading column ~720px; data ~1120px.
6. **Accessibility is a floor.** No informational text below 4.5:1; functional borders/icons 3:1; state never color-only.
7. **Motion marks change.** Honor `prefers-reduced-motion`.

## Do

- Use semantic tokens (`--color-text-strong`), never raw slate hex in components
- Pair status color with icon + word (e.g. attention triangle + “Needs review”)
- Show 2px focus ring, 2px offset, on keyboard focus

## Don’t

- Pill every control
- Purple SaaS chrome or cream+terracotta clichés
- Shadow on in-grid cards or dark-mode tone substitutes
- Invent proof evidence in empty states
