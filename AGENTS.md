# AGENTS.md — repo contract for coding agents

**c-thru** is a router/proxy layer letting Claude Code talk to alternative model
providers (Ollama, OpenRouter, Gemini, Bedrock, Vertex) without changing the vendor CLI.

## Hard constraints

- **No external Node dependencies.** `tools/claude-proxy`, `tools/model-map-*.js`,
  `tools/llm-capabilities-mcp.js` use Node stdlib only. No `package.json`, no `node_modules/`.
- **Two-directory invariant.** `tools/` + `config/` layout is required; both entrypoints compute
  `ROUTER_REPO_ROOT` as `$(dirname $0)/..` and read `$ROUTER_REPO_ROOT/config/model-map.json`.
- **Model-field rewriting is proxy-only.** Hooks may observe or gate but never modify
  `tool_input.model` / `body.model`.
- **No new `exec` calls in `tools/c-thru`** unless verified no proxy PID is live —
  `exec` skips the EXIT trap that kills the spawned proxy.
- **`config/model-map.json` is standard JSON** (parsed with `JSON.parse` — no comments).
- **Plugin bundle sync.** `plugins/c-thru/` mirrors source files (hooks, skills, config).
  After editing a mirrored source file run `tools/sync-plugin-bundle.sh`;
  check with `tools/sync-plugin-bundle.sh --check`.
- **Git:** stage explicit paths only (never `git add -A`/`-u`/`.`) — multiple sessions share
  this working tree. Do not commit unless explicitly asked.

## Verification commands

```sh
bash -n tools/c-thru                                     # bash syntax
node --check tools/claude-proxy tools/model-map-*.js     # node syntax
node tools/model-map-validate.js config/model-map.json   # schema validation
node test/model-map-v12-adapter.test.js                  # adapter regression
bash tools/c-thru-contract-check.sh                      # agent/skill contract integrity (run after editing skills/c-thru-plan/SKILL.md or agents/*.md)
node test/agent-description-quality.test.js              # agent description rules
make test-fast                                           # proxy + model-map suite (~2 min)
```

Individual suites live in `test/` and run directly (`node test/<name>.test.js`,
`bash test/<name>.test.sh`). `test/run-all.sh` (full run) needs exclusivity; `make test-fast`
is safe concurrently.

## Key architecture notes

- `tools/c-thru` (bash) resolves route → backend → env, spawns `tools/claude-proxy` (node)
  when needed, then launches the real `claude` binary with ephemeral session injection.
- `model_routes` values come in three shapes: string `"backend-id"`, v2 alias
  `{"endpoint": "...", "name": "..."}`, and mode-conditional
  `{"connected": "...", "offline": "..."}` (resolved via connectivity mode —
  see `resolve_llm_mode` in `tools/c-thru`).
- Routing modes: `best-cloud` | `best-cloud-oss` | `best-local-oss` | `best-cloud-gov` |
  `best-local-gov`; hardware tiers `16gb`…`128gb`. Resolution debugging:
  `tools/c-thru explain --model <m>` / `--capability <c> --mode <m>`.
- README's "Agent routing reference" table is generated: `node tools/gen-routing-doc.js`
  (`--check` in CI). Never hand-edit the marked region.
