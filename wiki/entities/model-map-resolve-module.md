---
name: Model-Map Resolve Module
type: entity
description: "Extracted shared module (tools/model-map-resolve.js) + CLI wrapper (c-thru-resolve) for resolveProfileModel/resolveLlmMode — single source of truth for proxy, SKILL.md inline scripts, and CLI"
tags: [model-map, resolution, module, extraction, c-thru-resolve]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [f20f3ade]
related: [capability-profile-model-layers, llm-mode-resolution, skill-config-reload-gaps, model-map-test-pattern]
---

# Model-Map Resolve Module

`tools/model-map-resolve.js` is the single source of truth for model resolution logic, extracted from `claude-proxy` to eliminate duplication across the proxy, SKILL.md inline node scripts, and CLI. The companion `c-thru-resolve` shell wrapper provides command-line access to the same resolution functions.

- **From Session f20f3ade:** Seven functions extracted from `claude-proxy` into `tools/model-map-resolve.js`: `resolveProfileModel`, `resolveLlmMode`, `resolveProfileName`, `resolveLogicalAlias`, `resolveCapabilityAlias`, `resolveConnectivityMode`, `KNOWN_CAP_ALIASES`. The module uses `module.exports` (CommonJS) so both `require()` and SKILL.md inline `node -e` can import it. Proxy imports via `const { resolveProfileModel, ... } = require(path.join(__dirname, 'model-map-resolve'))` — no relative path duplication. SKILL.md inline scripts reference via `$CLAUDE_DIR` (or `$HOME/.claude` fallback) + `/tools/model-map-resolve.js`.
- **From Session f20f3ade:** `c-thru-resolve` CLI wrapper at `tools/c-thru-resolve` (shell script) dispatches subcommands: `capability <hw> <cap> [mode]`, `profile <hw> <cap>`, `mode [value]`, `alias <cap>`. Each subcommand loads config and invokes the resolve module. Installed to `~/.claude/tools/` by `install.sh`.
- **From Session f20f3ade:** Reviewer caught a real bug: the `general-default → default` aliasKey remap existed in the `c-thru-resolve` CLI but was missing from the SKILL.md resolve block's inline node script. The SKILL.md inline script had `aliasKey = aliasKey.replace(/-default$/, '')` in the CLI but not in the SKILL.md version — meaning the inline script would resolve `general-default` differently from the CLI and proxy. Fixed by adding the remap to the SKILL.md inline script.
- **From Session f20f3ade:** 61-argument cartesian product test suite at `test/resolve-capability.test.js` validates all (capability × hw-tier × mode) triples. Mirror-drift guard in `test/llm-mode-resolution-matrix.test.js` (section 18) cross-checks the real resolver against its test stub — the extraction makes this guard more important since SKILL.md inline scripts now also import from the same module.

→ See also: [[capability-profile-model-layers]], [[llm-mode-resolution]], [[skill-config-reload-gaps]], [[model-map-test-pattern]]