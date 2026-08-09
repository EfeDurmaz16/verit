# Output style

Every string cyclops shows a human follows these rules: prompts, Check Run bodies, UI copy, docs.

1. Never use the em dash character. Use a period, a comma, or a colon.
2. Short sentences. One idea each.
3. Active voice. Name who does the thing.
4. Short words over long ones. Cut words that carry no meaning.
5. Name concrete files, functions, and behaviors, not "the system".
6. No filler openers, no hype, no praise.
7. Jargon only when the term names something exact.

The model-facing copy of this contract is `OUTPUT_STYLE` in `packages/domain/src/index.ts`.
It ships in the workspace lane prompt and in the compiled skill pack. `decodeUnderstanding`
strips any em dash the model still emits. Change this file and `OUTPUT_STYLE` together.
