# Connectivity modes — full reference

c-thru supports **5 built-in connectivity modes** that control how each capability resolves
to a concrete model, plus a `custom_modes` mechanism for declaring your own. Set the active
mode with `--mode <name>` on the c-thru CLI, with the `CLAUDE_LLM_MODE` environment variable,
or by setting `llm_mode` in `model-map.json`.

The mode is applied **per-capability**: `judge` and `coder` may resolve to different concrete
models in the same session under the same mode, depending on each capability's entry in
`llm_profiles[<capability>]`.

> **Coming from an older version of this doc?** c-thru used to ship ~16 modes
> (`semi-offload`, `cloud-judge-only`, `cloud-thinking`, `local-review`, `cloud-best-quality`,
> `local-best-quality`, `cloud-only`, `claude-only`, `opensource-only`, `fastest-possible`,
> `smallest-possible`, `best-opensource`, `best-opensource-cloud`, plus `connected`/`offline`/
> `local-only`). That system was collapsed to the 5 canonical modes below. None of the old
> mode names are selectable via `--mode` anymore (they're not in the shipped config and the
> runtime doesn't recognize them) — if you relied on one of them for a specific per-capability
> cloud/local split, declare a [custom mode](#custom-modes-user-definable-named-modes) instead.

---

## Resolution model

Every capability entry in `llm_profiles` is keyed **capability-first**, then by mode, then by
hardware tier:

```jsonc
{
  "llm_profiles": {
    "judge": {
      "best-cloud":     { "16gb": "...", "32gb": "...", "64gb": "...", "128gb": "..." },
      "best-cloud-oss": { "...": "..." },
      "best-local-oss": { "...": "..." },
      "on_failure": "cascade",       // or "hard_fail"
      "fallback_to": "workhorse"     // optional: next capability to try on exhaustion
    }
  }
}
```

`resolveProfileModel(capabilityEntry, mode, tier)` looks up `capabilityEntry[mode][tier]`
directly — there's no separate "override slot" concept for built-in modes; a mode's model
for a capability is whatever you put at that `[mode][tier]` path. (Declaring a
[custom mode](#custom-modes-user-definable-named-modes) adds one more key alongside the 5
built-ins, resolved with its own `base`-then-`best-cloud` fallback chain.)

A flat string value (no per-tier object) is also accepted and applies to every tier.

---

## Mode reference

| Mode | Intent |
|---|---|
| `best-cloud` | Anthropic-led cloud (Fable/Opus/Sonnet), with local small-model routing for selected roles/tiers. |
| `best-cloud-oss` | **Default.** Cloud-hosted OSS (DeepSeek, Kimi, GLM via `*:cloud` / OpenRouter); Anthropic fallback |
| `best-local-oss` | Fully local inference (Phi, Qwen, Devstral, Llama); no cloud egress |
| `best-cloud-gov` | USGov-compliant cloud — Anthropic + non-Chinese-origin OSS only; Chinese-origin models blocked |
| `best-local-gov` | USGov-compliant local — non-Chinese-origin local models only |

**Legacy aliases** (accepted for backward compatibility, normalized to a built-in before
resolution): `connected` → `best-cloud`; `offline` / `disconnect` → `best-local-oss`.

---

## What each mode is useful for

### `best-cloud`
Anthropic-primary. Use when you have Claude subscription/API credits and want highest-quality
routing regardless of cost. Falls back to local models at 64gb+ hardware tiers when a cloud
capability has no better option configured. Select with `--mode best-cloud` or
`CLAUDE_LLM_MODE=best-cloud`.

### `best-cloud-oss`
**Default.** Cloud-hosted open-source models (DeepSeek, Kimi, GLM, etc. — often via Ollama
cloud tags `*:cloud` or OpenRouter). Use Claude Code without spending Anthropic model credits.
Anthropic remains a cascade fallback when an OSS option fails unless you override `on_failure`.

### `best-local-oss`
Fully local — no cloud egress. Use for privacy-sensitive sessions, cost control, air-gapped
development, or testing local-only deployments. Also reachable via the `offline`/`disconnect`
legacy aliases.

### `best-cloud-gov` / `best-local-gov`
USGov-compliant variants of `best-cloud`/`best-local-oss`: any model whose family or vendor
is identified as Chinese-origin (`isChineseOrigin` — matches Qwen, DeepSeek, Kimi/Moonshot,
GLM/Zhipu, MiniMax, and others by family/vendor token) is blocked at both config-validation
time and runtime, even if a fallback chain would otherwise reach one.

**Commercial US cloud (not FedRAMP ATO by itself).** Selected capabilities (currently
`generalist` and `writer` at 32gb+) route to **Grok** (`grok-4.5` via `endpoints.xai`,
`XAI_API_KEY`) under `best-cloud-gov`. That is **Grok surface B** (silent capability pin) —
the same Anthropic-to-xAI Responses translation path as surface A, not the subscription-backed
Grok Build CLI (surface C). See `docs/agent-architecture.md` § Grok surfaces. It is a US commercial path
(GSA OneGov / xAI for Government framing); operators must confirm agency ATO before CUI.
High-stakes capabilities (`planner-hard`, `reviewer-security`, `coder`, `tester`,
`code-reviewer`, …) stay on Claude. Named agents `deepseek` / `qwen` / `kimi` pin
Chinese-origin models and are unsuitable in gov modes — use the `grok` brand leaf or Claude
instead.

---

## Verifying the mode worked

Every capability-driven response includes an `x-c-thru-resolved-via` header. Use it to
confirm routing:

```sh
curl -i -H 'x-api-key: ignored' http://127.0.0.1:9997/v1/messages \
  -d '{"model":"workhorse","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
# Look for: x-c-thru-resolved-via: {"capability":"workhorse","profile":"workhorse","served_by":"...","tier":"64gb","mode":"best-cloud","local_terminal_appended":false}
```

The proxy also exposes `/v1/active-models` which returns the resolved model list for the
current tier and mode without sending a real message:

```sh
curl http://127.0.0.1:9997/v1/active-models | jq
```

---

## Setting a capability's model for a specific mode

Add or edit the `[mode]` key under a capability in `model-map.overrides.json`:

```json
{
  "llm_profiles": {
    "judge": {
      "best-cloud": { "64gb": "claude-opus-4-6" }
    }
  }
}
```

This stacks on top of the system defaults (deep-merged). Reload with `c-thru reload` (or
`/c-thru-config reload` from a Claude session) to apply without restarting.

---

## Custom modes (user-definable named modes)

Beyond the built-in modes you can declare your own **custom modes** in
`model-map.json` (or `model-map.overrides.json`). A custom mode is a *label that maps
capabilities → models*: it names a **`base`** built-in mode plus optional per-capability
overrides. Capabilities you don't override resolve under `base`; everything is selectable
session-wide with `--mode <name>` (or `CLAUDE_LLM_MODE`).

Declare the mode under `custom_modes`:

```json
"custom_modes": {
  "deepseek-hybrid": {
    "base": "best-cloud-oss",
    "description": "DeepSeek v4 + best OSS; Claude for high-stakes"
  }
}
```

Override just the high-stakes capabilities by adding the custom-mode key to their
`llm_profiles` entry (the key value is a model string or a tier-keyed object, exactly like
a built-in mode slot):

```json
"llm_profiles": {
  "planner-hard":      { "best-cloud-oss": "deepseek-v4-pro:cloud", "deepseek-hybrid": "claude-opus-5" },
  "reviewer-security": { "best-cloud-oss": "deepseek-v4-pro:cloud", "deepseek-hybrid": "claude-opus-5" }
}
```

Resolution precedence, per capability:
`llm_profiles[cap][<custom mode>]` → `llm_profiles[cap][base]` → `llm_profiles[cap]["best-cloud"]`
(tier applies within each).

Rules enforced by the validator (`model-map-validate.js`):

- **`base` is required** and must name a built-in mode (`best-cloud`, `best-cloud-oss`,
  `best-local-oss`, `best-cloud-gov`, `best-local-gov`). Without it an OSS-style custom mode
  would fall back to Anthropic for every un-overridden capability.
- A custom mode **must not shadow** a built-in mode name or a legacy alias.
- **Gov safety:** if `base` is a gov mode, an override that names a Chinese-origin model is
  rejected — gov modes block those models and a custom mode can't smuggle one back in. The
  runtime Chinese-origin filter also engages for gov-*based* custom modes (it resolves through
  `base`, not just the literal mode name), so this is enforced at request time too — not only
  at validation.

Two behaviors worth knowing (both intentional, consistent with built-in modes):

- **Partial-tier overrides:** if a capability's custom-mode override (or its `base` entry) is a
  tier-keyed object that is *present but missing the active hardware tier*, resolution returns
  null (503) rather than silently falling through to `best-cloud`. Cover every tier you intend
  to serve, or use a flat string value (same model for all tiers).
- **Offline auto-detect:** the connectivity auto-detect that degrades plain `best-cloud` to
  `best-local-oss` when offline does **not** fire for a custom mode (even one based on
  `best-cloud`) — selecting a custom mode is an explicit choice, so it's kept as-is. Per-request
  local fallback still applies on dispatch failure. Use `--mode best-local-oss` (or a
  local-based custom mode) for offline work.

Select and verify it:

```sh
c-thru --mode deepseek-hybrid -p "…"
c-thru list                      # lists declared custom modes (name, base, description)
curl http://127.0.0.1:9997/c-thru/status | jq '{mode, base_mode, custom_modes}'
```

Custom modes vs. the other named mechanisms:
- **custom_modes** — a *mode* (label → many capability→model mappings, via `base` + overrides).
- **the 5 built-ins** — the fixed modes a custom mode builds on.
- **`routes`** — a flat label → a *single* model (e.g. `default`, `high-model`), unrelated to
  per-capability mode resolution.

---

## See also

- [`tournament_2026-04-25.md`](./tournament_2026-04-25.md) — model rankings used to inform
  mode-default choices in shipped config
- [`model-map-research-2026-04-25.md`](./model-map-research-2026-04-25.md) — how the report
  influenced the current capability assignments
