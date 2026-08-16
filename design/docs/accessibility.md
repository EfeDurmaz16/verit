# Accessibility (WCAG 2.2 AA)

## Floors

| Role | Ratio |
|---|---|
| Informational text | ≥ 4.5:1 (3:1 if ≥ 24px / 18.5px bold) |
| Functional non-text (borders, icons that convey state) | ≥ 3:1 |
| Decorative seams | may be weaker if spacing also groups |

Measured against intended surface (`canvas` or `surface-1`).

## Keyboard

- All controls focusable in logical order
- Focus visible: `2px solid var(--color-focus)`, offset `2px`
- Dialogs trap focus; Escape closes
- Command palette: type to filter, arrows, Enter, Escape

## Color

- Never rely on color alone for status (danger / success / attention)
- Greyscale still preserves hierarchy (weight + position)

## Motion / targets

- `prefers-reduced-motion`: durations → 0
- Coarse pointer: min 44×44px hit area (visual control may be smaller with padding)

## Screen readers

- Buttons named by consequence (“Publish proof”, not “Submit”)
- Form fields associate label + helper + error via `aria-describedby`
- Tables: header scope; empty state announced
