---
name: Hook Safety Posture
type: entity
description: "Design rule: c-thru hook scripts split into two groups — set -euo pipefail (fail-loud) vs set +e + ERR trap (always-exit-0)"
tags: [hooks, bash, safety, error-handling]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [be297e50]
related: [load-bearing-invariant]
---

# Hook Safety Posture

c-thru's Claude Code hook scripts split into two safety postures based on the load-bearing invariant. Hooks that feed into Claude's control flow (Stop, Statusline) must never block or error — they use `set +e` + `trap 'exit 0' ERR` and always exit 0. All other hook scripts (session-start, proxy-health, map-changed, classify) use `set -euo pipefail` to catch the A13 bug class (silent empty-string captures from failing commands).

- **From Session be297e50:** Adding `set -u` (undefined variable check) to the 4 non-statusline hooks was the key fix — it catches the case where `$(cmd_that_fails)` captures an empty string and execution continues silently. The statusline and stop hooks were intentionally skipped because they rely on `set +e` + ERR trap for always-zero-exit semantics. The Stop hook outputs either empty stdout or exactly one valid JSON object via `jq -cn`, and any `set -e` failure would break that contract.
- **From Session be297e50:** Soft-fail patterns in the always-exit-0 hooks: missing `jq`, missing/malformed log, and any unexpected error all trap to `exit 0`. The Stop hook uses `~/.claude/.c-thru-stop-hook-last-ts` (single epoch-ms integer) for dedup — only NEW fallback events produce a `systemMessage`.

→ See also: [[load-bearing-invariant]], [[claude-code-hook-channels]], [[hook-model-rewriting-removal]]