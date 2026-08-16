# Figma sync checklist

Figma MCP (`plugin-figma-figma`) authenticated in-session but subsequent `whoami` / `create_new_file` / `use_figma` calls failed with “MCP server does not exist.” Visual DS shipped in Paper; tokens live in-repo.

When Figma MCP is stable:

1. `whoami` → `create_new_file` name **Cyclops Design System**
2. Load `figma-use` + `figma-generate-library`
3. Import primitives + semantic Light/Dark from [`../tokens.json`](../tokens.json)
4. Bind scopes + `var(--…)` code syntax
5. Rebuild components against Paper screenshots as visual QA
6. Update `/tmp/dsb-state-cyclops-ds.json` with `fileKey`

Paper file: https://app.paper.design/file/01KYYHRE1J0YJA5AWE9JCBG6MM
