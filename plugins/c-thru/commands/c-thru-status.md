---
name: c-thru-status
description: "Show c-thru routes, proxy URL, per-model usage stats (calls, tokens, last call time), and backend health. Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
# c-thru Status
Run the list command. It shows: active profile, all 20 agents with model assignments and endpoints,
proxy URL with tier/mode, Ollama model count, backend health, and per-model usage stats
(call count, total tokens, timestamp of last call).

If `$ARGUMENTS` is empty or `--verbose`, run:
```bash
~/.claude/tools/c-thru --list $ARGUMENTS
```
