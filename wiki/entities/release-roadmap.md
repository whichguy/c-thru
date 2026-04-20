---
name: c-thru Release Roadmap
type: entity
description: "Phased release plan for c-thru: 1.1a (correctness), 1.1b (stream lifecycle + observability), 1.2 (schema upgrade), v2 (local-first gateway)"
tags: [releases, roadmap, planning]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [be297e50, 9d601210]
related: [declared-rewrites, load-bearing-invariant, router-lock-handshake, capability-profile-model-layers, connectivity-vs-cascade]
---

# c-thru Release Roadmap

The roadmap separates three distinct products: (1) c-thru 1.1 (hardened + observable), (2) c-thru 1.2 (schema upgrade), and (3) c-thru v2 (local-first gateway). Treating them as one pipeline would stall everything — each is a separate ship with explicit done criteria.

- **From Session be297e50:** **1.1a (correctness, shipped as e5a5dc5):** A13 first (set -euo pipefail), then A1 (lock race), A3 (SSE buffer bound at 512 MiB), A6 (0600 perms + opt-out on prompt log), A7 (kill -0 PID probe), A8 (UUID tmp paths), A9 (stderr split + cleanup trap), A10 (curl --max-time), A11 (grep -oE portability), A12 (install hook exact match). Dropped: A2 (header allowlist), A5 (env-name validation) — both violate transparency principle.
- **From Session be297e50:** **1.1b (stream lifecycle + observability):** Gated on D1 test matrix. Includes A18 (stream.pipeline for upstream socket cleanup), A21 (mid-stream upstream error → event: error SSE frame), A14 (stream-don't-buffer fallback chain), B3 (Keychain for API keys), B8 (shadow/compare mode), D2 (c-thru doctor), D6 (--explain/--dry-run). A24 is N/A for 1.1 — only applies to future `kind: "openai"` backends.
- **From Session be297e50:** **1.2 (schema upgrade):** C1 (model metadata: cost, context, tags), C2 (validator strictness), C3 (merge-semantics doc), B4 (FSEvents hot reload), B10 (per-backend probe tuning), B11 (upstream keep-alive pool), D7 (proxy state-machine diagram), D5 (CI).
- **From Session 9d601210:** **1.2 schema upgrade now has a concrete phased plan.** Phase A (non-breaking): new `schema_version`, `tool_capability_to_profile`, `profile_to_model`, `models[].equivalents` keys land alongside legacy schema. Dual-gate activation (`CLAUDE_PROXY_SCHEMA_V12=1` AND `config.schema_version === "1.2"`). `resolveCapabilityV12` runs alongside legacy resolver. `walkEquivalentsChain` replaces `fallback_strategies` on v1.2 path. `resolved_via` response header for observability. Phase B (flip default): blocked on connectivity-mode design decision (see [[connectivity-vs-cascade]]). Phase C (remove legacy, 30 days after B). Branch: `feat/schema-v12-capability-profile-model`.
- **From Session 9d601210:** **v1.2 pivoted from phased to single-phase.** Since nothing ships on v1.2 yet, the generational machinery (dual-gate, schema_version, migration script, deprecation warnings, Phase B/C reminder) is replaced by a loader-level adapter: `model-map-layered.js` synthesizes new shape from legacy config on read. Plan collapses ~550→~250 lines. Phase B connectivity-mode decision still blocks `on_failure=hard_fail` but not the core schema migration. See [[capability-profile-model-layers]] for pivot details.
- **From Session be297e50:** **v2 (local-first gateway, separate design doc):** B1 (UDS for internal control), B2 (launchd KeepAlive), B7 (SQLite usage ledger), B9 (latency cache), B5 (mDNS discovery), B6 (MLX/CoreML backend). Don't let v2 items block 1.1 shipping.

→ See also: [[declared-rewrites]], [[load-bearing-invariant]], [[router-lock-handshake]]