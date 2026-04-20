# model-map.json

The router reads a layered stack of `model-map.json` files and merges them:

1. `$PWD/model-map.json` — per-project override (optional).
2. `$HOME/.claude/model-map.json` — user profile (seeded by `install.sh`).
3. `<repo>/config/model-map.json` — shipped defaults.

## Shape

```json
{
  "backends":  { "<name>": { "kind": "anthropic|ollama|openrouter|bedrock|vertex|litellm", "url": "...", "auth": "..." } },
  "models":    { "<logical-name>": { "backend": "<backend-name>", "upstream": "<provider-model-id>", ... } },
  "routes":    { "<route-name>": { "model": "<logical-name>" } }
}
```

- **backends** — connection metadata (URL, auth strategy, kind).
- **models** — logical aliases mapped to `(backend, upstream-id, capabilities)`.
- **routes** — named presets resolved via `c-thru --route <name>`. `routes.default` is used when no flag is passed.

Validate with `model-map-validate <path>`. See `tools/model-map-validate.js` for the full schema and `tools/model-map-layered.js` for the merge order.
