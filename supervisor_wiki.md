# Supervisor Epistemic Wiki
This is the Living Knowledge Base of proven repo-specific facts.

## [INDEX] Core Constants
- **Proxy Core Port:** 9997 [E1]
- **Hooks Listener Port:** 9998 [E2]
- **Default RAM Tier:** selects 16gb if detection fails [E3]

## [INDEX] Environmental Invariants
- **Docker Binding:** Limited to 127.0.0.1 via Task 5 (Security Policy) [E4]
- **CI RAM Capacity:** Standard runners provide 7GB-14GB [E5]

## [INDEX] Architectural Logic
- **Routing:** Handled via weighted lookup in `model-map-resolve.js`.
- **Harness:** Isolation Protocol v3 is the current standard for evaluation.
- **Hooks Port Hardcoding:** Port 9998 is hardcoded in scripts (e.g., `c-thru-classify.sh`) to eliminate discovery latency for synchronous out-of-process hooks. [E6]

## [EVIDENCE_VAULT]
- [E1]: tools/c-thru@53 -> CLAUDE_PROXY_PORT:=9997
- [E2]: tools/claude-proxy@3427 -> hooksServer.listen(HOOKS_PORT, ...)
- [E3]: tools/hw-profile.js@L104
- [E4]: .claude/pending-tasks.md@Task 5
- [E5]: test/hw-profile.test.js@L22
- [E6]: wiki/entities/claude-code-hook-channels.md@L20 -> "Adding an HTTP round-trip per invocation is unacceptable latency..."
