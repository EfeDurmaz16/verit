# Anti-AI-slop & handcraft principles (Cyclops)

Synthesized from Emil Kowalski / interface-design craft rules, efe-design structural laws, and Mobbin refs ([Linear Preferences](https://mobbin.com/screens/c968b3b2-82a5-4044-8e4a-0bec5683dec5), [Linear Agent personalization](https://mobbin.com/screens/08a52eac-c188-4815-83c0-96d33232d93c), [Notion Team](https://mobbin.com/screens/6ad9e8d1-ebba-4221-9934-9e82ae321802)).

## What “AI slop” looks like

| Smell | Why it reads fake |
|---|---|
| Same purple/indigo SaaS kit everywhere | Shared training default |
| Card grid with equal shadows | Template assembly, not hierarchy |
| Accent on every chrome element | No restraint; nothing is special |
| Tight 16px padding everywhere | No rhythm between groups |
| Gradient blobs / glow / glass | Decoration without meaning |
| Inter + bold titles + pill CTAs | Stock “modern SaaS” |
| Empty state with illustration + 3 feature cards | Marketing page inside product |
| Color-only status | Lazy; fails greyscale |

**Test:** If another model given “dev tool dashboard” would ship the same screen, rewrite.

## Handcraft moves (do these)

1. **Subtract first.** If a border, shadow, card, or accent can leave without losing meaning, remove it.
2. **Monochrome carries hierarchy.** Black / charcoal / mid-gray / faint for text and chrome. One accent only on *the* verb (primary button, live, active spine), or none on reading surfaces.
3. **Whitespace is structure.** Within-group tight (8–12); between-group generous (32–56+). Page titles get air above and below.
4. **Content column, not full bleed.** Settings/proof ~560–720px centered in the content pane; don’t stretch forms to the window edge.
5. **Hairlines over boxes.** Prefer seam + spacing; box only for true discrete units (dialog, input).
6. **Weight before size.** Most hierarchy is 400/500/600 + muted color, not jumping display sizes.
7. **Concentric radius.** Outer = inner + padding. Mismatch screams generated.
8. **Optical alignment.** Icons in buttons, chevrons, status dots: nudge until it *looks* centered.
9. **Unseen details.** Tabular nums, font smoothing, focus rings, press scale `0.97`, `transition` on specific props only.
10. **Motion sparingly.** No animation on high-frequency actions (cmdk open via keyboard). Ease-out when you must.
11. **Signature from the product world.** Cyclops = proof reading calm + one-eye focus: quiet report column, not a neon “AI review” panel.
12. **Triple-encode state.** Color + glyph + word. Red only for danger.

## Cyclops v1.1 direction (user preference)

- **More grayscale / monochrome**: teal demoted; primary buttons may be near-black fill; teal optional for links/live only
- **More whitespace**: bump between-section spacing; reduce chrome density on proof templates
- **Ferah**: reading surfaces feel like Linear settings / Notion blank page, not a packed admin kit

## Product screens (v1.2 craft pass)

Page **09 Screens** in Paper: https://app.paper.design/file/01KYYHRE1J0YJA5AWE9JCBG6MM/A-0

| Screen | Intent |
|---|---|
| A · Proof report | Document reading: Linear issue-detail calm, Stripe props rail |
| B · Runs list | List density: Vercel/Linear list, fill-only nav, no spine |
| C · Empty workspace | Notion blank: type + underline CTA only |

Refs: [Linear issue](https://mobbin.com/screens/f00cc4fb-4083-43fc-a0fb-703a6c4ef771), [Stripe customer](https://mobbin.com/screens/1a4aa88b-e0be-49b2-a87f-1264e0b5e786)

Hard bans enforced: no active spine, no card soup, no pill tabs, ink not teal for chrome.
