---
name: Narrow Threat Model
type: entity
description: "c-thru's threat model: single-developer machine, no network adversary, no malicious config — only filesystem disclosure to other local users and proxy's own bugs"
tags: [security, threat-model, architecture, correctness]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [be297e50]
related: [declared-rewrites, load-bearing-invariant]
---

# Narrow Threat Model

c-thru runs on one developer's machine, invoked by a user who owns both the config and the API keys. There is no network adversary, no malicious config author, and no multi-tenant isolation requirement. The only genuine threats are: (i) filesystem disclosure of credentials/prompts to other local users and (ii) the proxy's own bugs corrupting state. Neither is a "security" problem in the usual sense — they're correctness.

- **From Session be297e50:** This threat model directly shaped the A-series fixes: A6 (0600 perms on classify-intent-signals.log + `CLAUDE_PROXY_LOG_PROMPTS=0` opt-out) addresses threat (i); A8 (UUID-suffixed tmp paths for atomic rename) and A3 (SSE buffer cap) address threat (ii). The `set -euo pipefail` posture (A13) surfaces the silent-failure variants that fall under threat (ii).
- **From Session be297e50:** This model is why A2 (header allowlist) and A5 (env-name validation) were DROPPED — the hypothetical attacks they prevent (header smuggling, env-name injection) require the adversary to already control the client process, at which point they have the API key on disk anyway. Adding policy beyond the threat model is a regression, per the declared-rewrites principle.
- **From Session be297e50:** A9 (ollama pull stderr separation) was scoped narrowly: separate stdout from stderr so captured strings don't end up in files readable by other local users. The 0600 temp file + `trap 'rm -f "$stderr_file"' RETURN` pattern specifically addresses threat (i) without adding content-scrubbing (which would be policy, not correctness).

→ See also: [[declared-rewrites]], [[load-bearing-invariant]]