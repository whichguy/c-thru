---
name: SSE Buffer Sizing
type: entity
description: "Bounded buffer for SSE frame accumulation in claude-proxy's Transform patcher — caps pathological streams that never emit \\n\\n delimiter"
tags: [proxy, sse, memory, correctness]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [be297e50]
related: [declared-rewrites]
---

# SSE Buffer Sizing

The SSE patcher Transform in `claude-proxy` accumulates bytes into `buf` until it sees the `\n\n` frame delimiter. A malformed or malicious backend that never emits the delimiter grows the buffer without limit. The fix is a cap with early `cb(err)` on overflow — `stream.destroy(new Error('SSE frame too large'))`.

- **From Session be297e50:** Cap was set at 64 MiB initially, then raised to 512 MiB after quality review. The reasoning: 64 MiB is "extremely large — only pathological streams trip it" but 512 MiB provides more headroom for legitimately large SSE frames from model responses. The cap is intentionally generous because hitting it terminates the stream — false positives are worse than the memory cost. The original plan suggested ~1MB but that was deemed too aggressive for real workloads.

→ See also: [[declared-rewrites]]