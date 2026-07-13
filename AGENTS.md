# AGENTS.md — repo contract for coding agents

**c-thru** is a router/proxy layer letting Claude Code talk to alternative model
providers (Ollama, OpenRouter, Gemini, Bedrock, Vertex) without changing the vendor CLI.

## Delegated coding agents

This file and the project `CLAUDE.md` are discovered by both Codex (`codex-worker` / `codex:codex-rescue`) and the Grok CLI (`grok-cc:grok-rescue`) when they work in this repository. The repository constraints, file-scope discipline, and applicable verification commands below apply to every delegated worker.

The "Sandbox limitations" section below is specific to `codex-worker`'s workspace-write sandbox — do not infer the same execution limits for Grok; report the actual environment and verification result for whichever worker ran the task.

## Hard constraints

See `CLAUDE.md` for the two-directory invariant, no external dependencies, proxy-only model rewriting, exec discipline, plugin bundle sync, git staging discipline, and Install and Verify commands — this file only adds what is specific to delegated coding agents.

Editing any `agents/*.md` file? Also run `bash tools/c-thru-contract-check.sh`, `node test/agent-description-quality.test.js`, and `node test/agent-dispatch-graph.test.js` before finishing — CLAUDE.md's Agentic plan/wave system section documents what each enforces.

## Sandbox limitations

- The Codex workspace-write sandbox cannot bind loopback TCP ports (`listen EPERM` on
  `127.0.0.1`) and cannot use `sysctl`.
- Suites that spawn the proxy or stub servers (`proxy-*.test.js`, `*-e2e` tests) fail with
  EPERM in the sandbox even when the code under test is correct.
- Report those runs as "blocked: needs native verification"; do not rework the tests to avoid
  port binds, and do not claim pass/fail from a sandboxed EPERM run.

## Key architecture notes

- `tools/c-thru` (bash) resolves route → backend → env, spawns `tools/claude-proxy` (node)
  when needed, then launches the real `claude` binary with ephemeral session injection.
- `model_routes` values come in three shapes: string `"backend-id"`, v2 alias
  `{"endpoint": "...", "name": "..."}`, and mode-conditional
  `{"connected": "...", "offline": "..."}` (resolved via connectivity mode —
  see `resolve_llm_mode` in `tools/c-thru`).
- Routing modes: `best-cloud` | `best-cloud-oss` | `best-local-oss` | `best-cloud-gov` |
  `best-local-gov`; hardware tiers `16gb`…`128gb`. Resolution debugging:
  `tools/c-thru explain --model <name>` / `--capability <c> --mode <m>`.
- README's "Agent routing reference" table is generated: `node tools/gen-routing-doc.js`
  (`--check` in CI). Never hand-edit the marked region.
