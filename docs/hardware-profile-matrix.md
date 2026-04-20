# Hardware Profile Matrix

The agentic plan/wave system maps 5 capability aliases across 6 hardware profiles.
Hardware tier is auto-detected at proxy startup via `tools/hw-profile.js:tierForGb()`.
The connected/disconnected split uses the existing `connected_model`/`disconnect_model` fields.

| Spec label | c-thru tier | Connectivity | judge | orchestrator | code-analyst | pattern-coder | deep-coder |
|---|---|---|---|---|---|---|---|
| A | 128gb | connected | claude-opus-4-6 | qwen3.6:35b | devstral-small:2 | qwen3-coder:30b | devstral-small:2 |
| B | 128gb | disconnected | qwen3.5:122b | qwen3.5:122b | devstral-small:2 | devstral-small:2 | devstral-small:2 |
| C | 64gb | connected | claude-opus-4-6 | qwen3.6:35b | devstral-small:2 | qwen3.6:35b | devstral-small:2 |
| D | 64gb | disconnected | qwen3.5:27b | qwen3.5:27b | devstral-small:2 | devstral-small:2 | devstral-small:2 |
| E | 48gb | connected | claude-opus-4-6 | qwen3.5:9b | qwen3.5:9b | qwen3.5:9b | devstral-small:2 |
| F | 48gb | disconnected | qwen3.5:27b | qwen3.5:27b | qwen3.5:27b | qwen3.5:27b | qwen3.5:27b |
| — | 32gb | any | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b |
| — | 16gb | any | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b |

**judge-strict** mirrors `judge` per tier but with `on_failure: hard_fail` (no cascade to a lower model). Used only by `security-reviewer`.

**16gb/32gb:** All aliases collapse to `qwen3.5:1.7b`. `judge` and `judge-strict` use `on_failure: hard_fail` to surface the capability gap rather than silently returning a degraded result.

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
  → llm_profiles["128gb"]["deep-coder"].connected_model = "devstral-small:2"
```

Swapping an agent to a different tier: one line in `agent_to_capability`.
Swapping a tier's backing model: one line in `llm_profiles[<hw>][<alias>]`.
Agent files never need to change.
