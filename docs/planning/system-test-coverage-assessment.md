# System-test coverage assessment (c-thru)

Produced by a multi-agent assessment (6 dimension assessors over the live test tree + source → a
cross-cutting synthesis critic). Question: *do we have the right system/integration tests, or need to expand
coverage?* Answer: **roughly the right shape, but ~6 high-leverage end-to-end holes at the trust/failure
seams — and one broken exit-code gate (now fixed).**

## Per-dimension grades
| Dimension | Grade |
|---|---|
| Routing & resolution (req → resolveBackend → dispatch → headers) | **strong** |
| Protocol / translation (anthropic / gemini / ollama / files / models) | **strong** |
| Fallback cascade / cooldown / config reload | adequate |
| Launcher + install/uninstall + proxy lifecycle (bash) | adequate |
| Config layering + concurrent/shared-proxy | adequate |
| **Agent delegation end-to-end (hook → sentinel → routing → telemetry)** | **thin** |

## Verdict
Strong hermetic unit + happy-path routing/translation coverage across 51 spawned-proxy suites with a real
`withProxy`/`stubBackend` harness. But the **trust-granting and failure-handling edges** — the parts that
matter most for a security-sensitive router — are the least covered end-to-end. The recurring pattern: a
security/correctness control was added (HMAC sentinel, gov filter, C12 auth-strip, per-user secret
generation, project-overlay Pass 2) and then "tested" only by a hand-copied reimplementation, a
pure-function string-extraction, or a negative-only assertion — never through the real code path of a
spawned proxy or the real launcher.

## FIXED IMMEDIATELY (P0, this commit)
**`proxy-runtime-fallback.test.js` could not go red.** It ended with a bare `summary();` (every sibling does
`const failed = summary(); process.exit(failed>0?1:0)`), so a failed assertion still exited 0 — `run-all.sh`
keys on exit code, so the entire fallback dimension was painted green. This also explains the "Test 10 is
order-dependent" framing: it is **not** — Test 10's assertion failed *deterministically* (it expected the
cooldowned primary `A` to be re-dispatched on req2, but `A` also failed 500 on req1 so it's correctly
cooldown-skipped → `A=1`, not 2); the ungated exit just hid it. **Fix:** wired the exit code + corrected the
Test 10 assertion/comment. Now 89/89, and the suite will fail loudly on a real regression.

## Cross-cutting gaps (no single dimension owns these)
1. **No end-to-end agent-delegation test** spans hook → `[[c-thru-agent:name:hmac]]` body marker → spawned proxy `parseAgentSentinel` → C19 HMAC trust gate → routing override → `by_agent` telemetry. Zero spawned-proxy suites send a sentinel marker; the HMAC gate is system-tested only by a hand-copied `trustBodyMarker()` reimplementation. (The control-token gate *is* spawned-tested — asymmetry.)
2. **Security posture untested as a system:** no bash test references `ensure_per_user_secrets` / `agent-hmac.key` / `proxy.control-token` generation — nothing proves the launcher creates them (0600, idempotent, before spawn) and the spawned proxy enforces against the launcher-generated key.
3. **C12 auth-strip unreachable by any spawned proxy:** every stub binds 127.0.0.1 → `deriveAuthProfile` returns `none` (always-forward), so `withProxy` structurally can't hit the strip branch; it's covered only by a `new Function()` string-extraction of `applyOutboundAuth` (breaks silently on rename).
4. **Streaming never exercised through fallback/cooldown** (`stream:true` count == 0 in all fallback suites), yet streaming is Claude Code's default and has separate dispatch/error/cooldown handlers.
5. **Concurrent shared-proxy half-covered:** `proxy-concurrent` only fires against healthy backends (never failing), so `failedBackendUntil` race-safety under concurrent failures+clears is untested; the explicit-port cross-session reuse lock (flock vs mkdir-lockdir) has no test.
6. **Gov filter only tested pre-dispatch, never at cascade time** (no test fails a primary then asserts the fallback walk skips a Chinese-origin node), and **custom_modes are never positively routed** through a spawned proxy (only the orphan-degrade case).
7. **Project-overlay Pass 2 positive path untested** (`model-map-config-project-overlay` asserts only the no-pollution negative with `syncProfile:false`); the overlay temp-file security defense (per-uid 0700 dir, symlink guard) has no test.

## Prioritized recommendations (hermetic-first)
- **P0 — DONE:** gate `proxy-runtime-fallback` exit code + fix Test 10.
- **P0 — `proxy-agent-sentinel-e2e.test.js` (new, medium):** first spawned-proxy test that sends a `[[c-thru-agent:…]]` body marker and asserts override + routing + `by_agent`, plus the C19 HMAC gate against a real key *file* (unsigned→reject / valid→accept / key-absent→fail-open). Closes the HMAC-vs-control-token asymmetry.
- **P0 — launcher secret-gen + file→proxy loop (new, medium):** assert `ensure_per_user_secrets` creates both files (0600, 64-hex, idempotent, before spawn) and a proxy spawned against them enforces.
- **P1 — `proxy-auth-strip-e2e.test.js` (medium):** make C12's strip branch reachable (a `FORCE_UNKNOWN_HOST` test hook or a non-`KNOWN_HOSTS` name resolving to loopback); assert incoming Anthropic auth is stripped to an unknown host. Converts the most security-load-bearing branch from string-extraction to a real request.
- **P1 — streaming + cascade-time gov-filter cases** in the fallback suites: a `stream:true` primary-fails-before-first-byte fallback, and a gov-mode cascade where the walk must skip a Chinese-origin `fallback_to` node.
- **P1 — custom_modes positive routing** (`proxy-custom-mode-routing.test.js`) + **project-overlay Pass 2 positive + temp-file safety**.
- **P2:** cross-session secret stability; explicit-port reuse-lock bash test; cross-provider concurrent dispatch; cooldown clear-on-success + under-concurrency; Gemini hang-on-headers (C32) timeout.
- **P1 — harness hardening:** make `withProxy` track/clear timers and gate `helpers.js`'s `unhandledRejection→process.exit(1)` so a stray timer can't flip a suite's exit code after `summary()`; run proxy-spawn suites serially even in `--fast`. This makes green/red trustworthy (today a spawn suite's green can mask a logic failure and its red can be pure flake — indistinguishable without reading the body).
- **P2 — scheduled CI for the live suites** (`C_THRU_LIVE_*`, `agent-scenarios-e2e`, cross-provider parity): they're the only thing that catches upstream wire-shape drift + real agent selection, but self-skip behind env gates and "rarely run cleanly" — run them on a schedule so hermetic-stub staleness is caught. These are the few gaps that genuinely cannot be hermetic.

## Test-infra health
Solid harness (real proxy spawn, good stubs, hermetic-first, meta-coverage gates `run-all-coverage`/`gate-coverage`) — but two systemic issues: (1) the now-fixed ungated-exit defect shows exit-code gating isn't uniformly enforced; a lint/meta-test that every `*.test.js` ends in `process.exit(failed>0?1:0)` would prevent recurrence. (2) All 51 spawn suites share the `waitForPing` ECONNRESET / dangling-timer flake; combined with the `unhandledRejection→exit(1)` guard, a spawn suite's green can mask a logic failure and its red can be pure flake. Hermetic-vs-spawn balance is good; the real over-reliance is on opt-in/live suites that rarely run.
