---
name: Config Swap Invariant
type: entity
description: "Safety guarantee: a bad config on disk never replaces a good live config in reloadConfigFromDisk (validate-before-swap, atomic mtime)"
tags: [proxy, config, invariant, reload, safety]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [b8f0466a, 9d601210]
related: [sighup-config-reload, load-bearing-invariant, declared-rewrites, capability-profile-model-layers]
---

# Config Swap Invariant

When `claude-proxy` hot-reloads config via SIGHUP or `fs.watch`, a bad or malformed config on disk must never replace the working live config. The reload path validates `nextConfig` before assigning it to the global `CONFIG`, and captures `CONFIG_MTIME_MS` at read time (before validation) so that a `statSync` failure mid-validation cannot leave the system in a half-swapped state.

- **From Session b8f0466a:** Three bugs in `reloadConfigFromDisk` violated this invariant before it was codified: (1) `validateRouteGraph` called `process.exit(1)` on bad routes — a SIGHUP with a bad config would kill the proxy instead of preserving the good config; (2) CONFIG was swapped before validation ran, so a failed validation left the bad config installed; (3) `CONFIG_MTIME_MS` was captured via `statSync` after CONFIG was already overwritten — if `statSync` threw, the catch block logged "keeping old config" but CONFIG already contained new (unverified) content. All three fixed: validator now throws instead of exiting, validate-then-swap ordering enforced, and `nextMtime` captured at read time. A follow-up commit (9594a42) also closed a `validateWithNode` TOCTOU — the validator was reading from disk instead of the in-memory `nextConfig`, so a concurrent edit could cause the validator to approve a different config than what gets installed. Fix: `reloadConfigFromDisk` writes `nextConfig` to a tmpfile and passes it as `pathToValidate`.

- **From Session 9d601210:** The v1.2 resolver (`resolveCapabilityV12`) must also honor this invariant: it must snapshot `config.tool_capability_to_profile`, `config.profile_to_model`, and `config.models` into local `const` bindings at entry before any async yield or await. The SIGHUP handler can swap the module-level `config` reference at any point mid-request, so a v12 request that reads config after an async boundary could see a half-swapped state. Verification must include a reload-during-request test: send a request, issue SIGHUP mid-flight, and confirm the in-flight request resolves against the config snapshot, not the reloaded config.

→ See also: [[sighup-config-reload]], [[load-bearing-invariant]], [[declared-rewrites]], [[capability-profile-model-layers]]