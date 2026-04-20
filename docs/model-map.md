# model-map.json

The router reads a layered stack of `model-map.json` files and merges them:

1. `$PWD/model-map.json` — per-project override (optional).
2. `$HOME/.claude/model-map.json` — user profile (seeded by `install.sh`).
3. `<repo>/config/model-map.json` — shipped defaults.

## Shape

```json
{
  "backends":      { "<name>": { "kind": "anthropic|ollama|openrouter|bedrock|vertex|litellm", "url": "...", "auth_env": "..." } },
  "model_routes":  { "<model-name>": "<backend-name>" },
  "routes":        { "<route-name>": "<model-name-or-alias>" },
  "models":        [ { "name": "<model-name>", "equivalents": ["<fallback-model>"] } ]
}
```

- **backends** — connection metadata (URL, auth strategy, kind).
- **model_routes** — maps concrete model names to backend IDs. Supports `@<backend>` sigil suffix and glob/regex pattern keys.
- **routes** — named presets (flat string→string) resolved via `c-thru --route <name>`. `routes.default` is used when no flag is passed. Values are model names or alias chains.
- **models** — sparse array of model entries; each has `name` and optional `equivalents[]` for fallback cascade.

Validate with `model-map-validate <path>`. See `tools/model-map-validate.js` for the full schema and `tools/model-map-layered.js` for the merge order.
