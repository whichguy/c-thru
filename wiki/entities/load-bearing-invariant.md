---
name: Load-Bearing Invariant
type: entity
description: "Core safety guarantee: c-thru never blocks claude from working — worst case it's a no-op (CLAUDE_PROXY_BYPASS=1)"
tags: [architecture, safety, bypass, regression-test]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [be297e50]
related: [declared-rewrites, hook-safety-posture, router-lock-handshake, narrow-threat-model, config-swap-invariant]
---

# Load-Bearing Invariant

**c-thru never blocks `claude` from working.** The worst-case behavior is a transparent no-op via `CLAUDE_PROXY_BYPASS=1`. This invariant deserves a named regression test in D1 and promotion to a first-class concept in README + `c-thru doctor` output. Every correctness fix must preserve it.

- **From Session be297e50:** This invariant is the primary reason hook scripts use `set +e` + `trap 'exit 0' ERR` and always exit 0 — a hook failure must never block Claude's response. Similarly, the proxy's flock-based locking race fix (A1) was evaluated through this lens: a stale lock holder must not prevent the second router from proceeding.
- **From Session be297e50:** The bypass invariant test is: `CLAUDE_PROXY_BYPASS=1 claude --version` must work identically to vendor-native `claude --version` even with c-thru fully broken. This is a regression test to add to CI (D5) and the D1 test matrix.

→ See also: [[declared-rewrites]], [[hook-safety-posture]], [[router-lock-handshake]], [[narrow-threat-model]], [[config-swap-invariant]]