# Hardware Profile Matrix

The agentic plan/wave system maps capability aliases across 5 hardware profiles.
Hardware tier is auto-detected at proxy startup via `tools/hw-profile.js:tierForGb()`.
`connected_model` = cloud available; `disconnect_model` = offline fallback.

## Connected model by tier

| Alias | 128gb | 64gb | 48gb | 32gb | 16gb |
|---|---|---|---|---|---|
| `judge` | claude-opus-4-6 | claude-opus-4-6 | claude-opus-4-6 | qwen3:1.7b ⚠ | qwen3:1.7b ⚠ |
| `judge-strict` | claude-opus-4-6 | claude-opus-4-6 | claude-opus-4-6 | qwen3:1.7b ⚠ | qwen3:1.7b ⚠ |
| `orchestrator` | qwen3.6:35b | qwen3.6:27b-coding-nvfp4 | gpt-oss:20b | gpt-oss:20b | qwen3:1.7b |
| `local-planner` | qwen3.6:35b | qwen3.6:27b-coding-nvfp4 | qwen3.6:27b-coding-nvfp4 | gpt-oss:20b | qwen3:1.7b |
| `deep-coder` | qwen3-coder:30b | gpt-oss:20b | gpt-oss:20b | gpt-oss:20b | qwen3:1.7b |
| `code-analyst` | gpt-oss:20b | gpt-oss:20b | gpt-oss:20b | gpt-oss:20b | qwen3:1.7b |
| `pattern-coder` | qwen3-coder:30b | qwen3.6:27b-coding-nvfp4 | qwen3.6:27b-coding-nvfp4 | qwen3.5:9b | qwen3:1.7b |
| `reasoner` † | deepseek-r1:14b | deepseek-r1:14b | deepseek-r1:14b | gpt-oss:20b | qwen3:1.7b |
| `code-analyst-light` † | gemma4:26b | gpt-oss:20b | gemma4:e2b | gemma4:e2b | qwen3:1.7b |
| `deep-coder-precise` † | qwen3.6:35b-a3b-coding-bf16 | qwen3.6:35b-a3b-coding-mxfp8 | qwen3.6:35b-a3b-coding-nvfp4 | qwen3:1.7b ⚠ | qwen3:1.7b ⚠ |
| `fast-scout` † | gemma4:26b | gpt-oss:20b | gemma4:e2b | gemma4:e2b | qwen3:1.7b |
| `commit-message-generator` | qwen3:1.7b | qwen3:1.7b | qwen3.6:27b-coding-nvfp4 | qwen3:1.7b | qwen3:1.7b |

⚠ = `on_failure: hard_fail` (surfaces capability gap instead of silently degrading)  
† = pending alias — defined in `llm_profiles` but not yet bound in `agent_to_capability`; see `docs/agent-architecture.md#pending-capability-aliases`

## Disconnect model by tier (offline / cloud unavailable)

| Alias | 128gb | 64gb | 48gb | 32gb | 16gb |
|---|---|---|---|---|---|
| `judge` | qwen3.6:35b | qwen3.6:35b-a3b-coding-nvfp4 | qwen3.6:35b-a3b-coding-nvfp4 | qwen3:1.7b ⚠ | qwen3:1.7b ⚠ |
| `orchestrator` | qwen3.6:35b | qwen3.6:35b-a3b-coding-nvfp4 | qwen3.6:35b-a3b-coding-nvfp4 | gpt-oss:20b | qwen3:1.7b |
| `deep-coder` | qwen3-coder:30b | qwen3.6:27b-coding-nvfp4 | qwen3.6:27b-coding-nvfp4 | gpt-oss:20b | qwen3:1.7b |
| `deep-coder-precise` † | qwen3.6:35b-a3b-coding-bf16 | qwen3.6:35b-a3b-coding-mxfp8 | qwen3.6:35b-a3b-coding-nvfp4 | qwen3:1.7b ⚠ | qwen3:1.7b ⚠ |

(Other aliases: disconnect_model mirrors connected_model — see `config/model-map.json` for full detail.)

## Agent → capability mapping

| Agent | Capability | Notes |
|---|---|---|
| `planner`, `auditor`, `review-plan`, `final-reviewer`, `journal-digester`, `uplift-decider` | `judge` | cloud: claude-opus-4-6; local: qwen3.6:35b |
| `security-reviewer` | `judge-strict` | hard_fail — no cascade |
| `plan-orchestrator`, `integrator`, `doc-writer` | `orchestrator` | |
| `planner-local` | `local-planner` | dep_update signal only |
| `implementer` | `deep-coder` | |
| `test-writer`, `wave-reviewer`, `converger` | `code-analyst` | |
| `wave-synthesizer`, `learnings-consolidator` | `code-analyst` | candidate for `code-analyst-light` once scored |
| `scaffolder`, `discovery-advisor` | `pattern-coder` | |
| `explorer` | `pattern-coder` | candidate for `fast-scout` once scored |
| `evaluator`, `supervisor`, `supervisor-debug` | `judge` | legacy investigation agents |
| (deterministic path) | `commit-message-generator` | |

## Tier override

Verify detected tier:
```sh
~/.claude/tools/c-thru --list
```

Override for testing (e.g. simulate 48gb machine):
```sh
CLAUDE_LLM_MEMORY_GB=48 ~/.claude/tools/c-thru --list
```

## Resolution path

`model: implementer` in an agent frontmatter resolves as:

```
implementer
  → agent_to_capability["implementer"] = "deep-coder"
  → llm_profiles["128gb"]["deep-coder"].connected_model = "qwen3-coder:30b"
```

Swapping an agent to a different tier: one line in `agent_to_capability`.
Swapping a tier's backing model: one line in `llm_profiles[<hw>][<alias>]`.
Agent files never need to change.
