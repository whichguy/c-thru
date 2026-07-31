# Subscription Auth — Using Your Account Subscriptions with c-thru

c-thru supports routing requests through provider subscriptions rather than pay-per-token
API keys. This page explains what's available per provider and how to configure it.

---

## TL;DR per provider

| Provider | Subscription → API path? | How |
|---|---|---|
| **Claude / Anthropic** | Yes | `claude login` stores OAuth; c-thru injects `ANTHROPIC_AUTH_TOKEN` on the proxy path and routes via subscription credits |
| **Gemini / Google** | Partial | AI Studio free tier has generous quotas; Google One AI Premium doesn't add API credits |
| **OpenAI** | No (Platform API) / Yes (Codex CLI only) | ChatGPT Plus/Pro is web-only for the generic `api.openai.com` HTTP API — always metered. The separate **Codex CLI**'s own ChatGPT-sign-in mode bills against plan-included credits instead, but that's a distinct, product-specific integration, not something reachable via a REST API key. See "Delegate CLIs" below. |

---

## Claude (Anthropic)

### The flow

Claude Code supports two auth modes:
- **API key** (`ANTHROPIC_API_KEY`): pay-per-token; billed to your API account
- **Subscription** (`ANTHROPIC_AUTH_TOKEN`): charged against your claude.ai Pro/Max plan's included credits

When you run `claude login`, Claude Code stores an OAuth refresh/access token in the
macOS Keychain (`Claude Code-credentials`) or, on Linux, in
`~/.claude/.credentials.json`. By default c-thru lifts the saved access token into
`ANTHROPIC_AUTH_TOKEN` for the proxy hop. Installed Claude Code 2.1.220 was also
verified to use its saved login with c-thru's custom `ANTHROPIC_BASE_URL`; setting
`C_THRU_NO_OAUTH_INJECT=1` opts into that client-managed, version-dependent path.
The proxy forwards Bearer auth to Anthropic and strips a simultaneous `x-api-key`
header.

**Ambient-only `ANTHROPIC_API_KEY`:** in the default
`C_THRU_ANTHROPIC_AUTH_MODE=auto` mode, c-thru does **not** invent or export an API
key. If the **caller shell** already set `ANTHROPIC_API_KEY`, c-thru preserves it and
skips OAuth injection. Claude Code then selects API-key auth ahead of saved
subscription login, so the request uses metered API billing.

Set `C_THRU_ANTHROPIC_AUTH_MODE=subscription` to make that intent deterministic.
The wrapper removes `ANTHROPIC_API_KEY` before either claude-proxy or Claude Code is
started, then preserves/injects Bearer OAuth or lets Claude use its saved login. The
inverse `api` mode removes Bearer/OAuth environment signals and fails closed unless
`ANTHROPIC_API_KEY` exists. Placeholders (`proxied-placeholder`) are cleared when a
Bearer is present. Opt-in invent only: `C_THRU_PROXY_PLACEHOLDER_KEY=1` (see
`docs/env-vars.md`).

### Corporate gateway / ambient `ANTHROPIC_BASE_URL` (upstream override)

Point the **proxy** (not Claude) at an org reverse proxy / LLM gateway:

1. **Claude** still talks only to c-thru’s **loopback** proxy (fleet routing intact).
2. **claude-proxy** sends Anthropic-family traffic to the override URL
   (`CLAUDE_PROXY_ANTHROPIC_UPSTREAM`) instead of `endpoints.anthropic.url`.
3. **Ambient trust is opt-in:** a leftover shell `ANTHROPIC_BASE_URL` is **not**
   adopted as upstream unless `C_THRU_TRUST_AMBIENT_UPSTREAM=1`. Prefer explicit
   `--anthropic-upstream` / `C_THRU_ANTHROPIC_UPSTREAM` (no trust gate). Use
   `C_THRU_IGNORE_AMBIENT_ANTHROPIC_BASE_URL=1` to force-skip ambient even when
   trust is set.
4. **Credential policy is Loose (#2):** c-thru still injects subscription OAuth from
   the keychain when no ambient `ANTHROPIC_API_KEY` is set. The gateway receives the
   same `Authorization: Bearer` Claude would send to Anthropic (Claude Code may also
   attach its own keychain token). Only set the override to hosts you trust. A one-line
   stderr warn fires when the host is not `*.anthropic.com`.
5. Auth **shape** stays Anthropic-family (`bearer_priority` / `subscription`) via a
   transport/identity split — the map URL is not rewritten to the gateway host.
6. Loopback and plain `http://` overrides are refused unless explicit opt-in envs
   (see `docs/env-vars.md`). If the proxy cannot start while an override is active,
   c-thru **hard-fails** (never falls through to map `api.anthropic.com`).
7. **`c-thru reload` (SIGHUP)** re-reads the model-map only — it does **not** change
   the transport override (env is fixed at process start). Use **`c-thru restart`**
   (re-resolves ambient/env) or a new launch after changing the upstream.

```sh
# Preferred: explicit transport (no ambient trust required)
claude login
c-thru --anthropic-upstream https://llm-gateway.example.com/anthropic --model sonnet

# Or ambient BASE_URL with explicit trust
export ANTHROPIC_BASE_URL=https://llm-gateway.example.com/anthropic
export C_THRU_TRUST_AMBIENT_UPSTREAM=1
claude login
c-thru --model sonnet
# Claude → http://127.0.0.1:<port> ; proxy → https://llm-gateway.example.com/anthropic
```

```sh
claude login
C_THRU_ANTHROPIC_AUTH_MODE=subscription c-thru --model sonnet
```

For older installed wrappers without the explicit mode, the equivalent one-shot
fallback is `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN c-thru --model sonnet`.

### Enforcing subscription-only with `auth: "subscription"`

Add the `anthropic_subscription` endpoint to your `model-map.overrides.json` routes to hard-block
API key billing on that endpoint:

```json
{
  "routes": {
    "default": {
      "model": "claude-sonnet-5",
      "backend": "anthropic_subscription"
    }
  }
}
```

The `anthropic_subscription` endpoint (pre-declared in `config/model-map.json`) uses
`auth: "subscription"`. If a request arrives authenticated via `x-api-key` (API billing),
the proxy returns HTTP 401 with a message guiding you to `claude login`. Only
`Authorization: Bearer <session_token>` (subscription) is accepted.

### Checking which auth mode is active

`c-thru list` and `c-thru explain` prove routing, not the credential Claude actually
selected. For a fail-closed check, route through `anthropic_subscription`: a successful
request with `x-c-thru-auth-derived: subscription` proves the proxy accepted Bearer auth;
an API-key-only request is rejected before Anthropic. Provider billing/usage records remain
the final external check.

---

## Gemini (Google)

### AI Studio free tier

`GOOGLE_API_KEY` from [Google AI Studio](https://aistudio.google.com/) is **free** up to generous
per-model daily limits on Gemini 3 Flash (the current default free-tier model). Google no longer
publishes a single static number for this — limits vary by account, usage tier, and region and can
change over time — so check your project's live limits at
[aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit) rather than trusting a
hardcoded figure here. This is what the `gemini_ai` endpoint uses.

```sh
export GOOGLE_API_KEY="AIza..."   # from aistudio.google.com/apikey
c-thru --route gemini             # use Gemini free tier
```

### Google One AI Premium

Google One AI Premium adds Gemini Advanced access in Google's consumer apps (Gemini.google.com,
Gmail, Docs, etc.). It does **not** add API credits. API usage is always billed separately
through Google Cloud or AI Studio.

### Vertex AI

Vertex AI Gemini requires `GOOGLE_CLOUD_TOKEN` (OAuth bearer) and is billed through GCP.
Use the `gemini_vertex` endpoint for this.

---

## OpenAI

ChatGPT Plus and Pro subscriptions are for [chat.openai.com](https://chat.openai.com) only.
They do **not** give access to the generic OpenAI Platform HTTP API (`api.openai.com`).
API usage through that surface always requires a separate API key from
[platform.openai.com](https://platform.openai.com) and is billed per token. This applies
to c-thru's own `openai` proxy endpoint (when configured) exactly as it does to any other
direct caller of the Platform API — there is no subscription→API path for a REST endpoint.

The **Codex CLI** is a separate exception: its own ChatGPT-sign-in mode is a
product-specific integration (not the public Platform API) that bills against
plan-included credits. See "Delegate CLIs" below for how that's handled outside c-thru's
proxy.

### Alternatives within c-thru

- **OpenRouter**: routes to GPT-4o, o3, and other OpenAI models through OpenRouter's API.
  OpenRouter has its own billing (per-token) but often at lower rates. Set `OPENROUTER_API_KEY`
  and use the `openrouter` endpoint.
- **Local models**: `best-local-oss` mode uses local Ollama models for free.

---

## Delegate CLIs (Codex / Grok Build) — not proxy-owned

The Codex CLI (`codex-worker`/`codex:codex-rescue`) and the Grok Build CLI
(`grok-cc:grok-rescue`) are separate subprocesses invoked outside c-thru's proxy
entirely — none of the `KNOWN_HOSTS`/`applyOutboundAuth` machinery above applies to them.
Both, however, implement the same conceptual policy this page documents for Claude:
**prefer subscription/login-based billing, and fall back to a metered API key only when
login genuinely isn't available.**

The similarly named c-thru model route `grok-build` is deliberately different:
it maps Claude Code's Anthropic Messages traffic to `grok-4.5` on
`api.x.ai/v1/responses` and therefore always requires a billable `XAI_API_KEY`.
Neither route borrows credentials from the other.

- **Codex CLI**: `codex-worker-run.sh` runs a `codex login status` preflight check
  before every launch/resume. When a ChatGPT session is confirmed, it actively strips
  `OPENAI_API_KEY`/`CODEX_API_KEY` from the environment before invoking `codex`, closing
  a confirmed inversion risk where an ambient key would otherwise silently redirect
  billing to metered API-key mode even with a valid ChatGPT session active (`codex
  doctor` surfaces this as "mixed auth signals" — `codex login status` alone cannot see
  it). Only when no ChatGPT session exists does it fall back to an API key, with a
  clear log line noting the fallback. See `~/.claude/agents/codex-worker.md`'s "Auth
  mode" section for details.
- **Grok Build CLI**: `grok-companion.mjs` prefers a cached `grok login` session
  (tied to a SuperGrok/X Premium pooled usage quota) and strips an ambient `XAI_API_KEY`
  from the child process whenever a login session is present, to avoid the same class of
  inversion risk. It falls back to `XAI_API_KEY` only when no login session is found.
  See the `grok-cc` plugin's `skills/grok-cli-runtime/SKILL.md` for details.

---

## Custom session cookie auth

For any provider that authenticates via session cookies (internal tools, self-hosted LLMs),
the `auth` object already supports arbitrary headers:

```json
"my_internal_llm": {
  "url": "https://llm.internal.company.com",
  "format": "anthropic",
  "auth": {
    "header": "Cookie",
    "env": "MY_SESSION_COOKIE",
    "scheme": ""
  }
}
```

Set `MY_SESSION_COOKIE=sessionId=abc123; user=me` in your environment. The proxy will forward
that as the `Cookie` header on all outbound requests to that endpoint.

---

## `auth: "subscription"` — reference

Available values for the `auth` field on an endpoint:

| Value | Behavior |
|---|---|
| `"none"` | Strip all auth headers; inject nothing (for local Ollama) |
| `"subscription"` | Only forward `Authorization: Bearer` (subscription/session tokens). Reject `x-api-key` (API billing) with HTTP 401 |
| `{ env, header, scheme }` | Inject configured header from env var |
| absent | Passthrough: forward whatever auth the client sends |

The `anthropic_subscription` endpoint in `config/model-map.json` is pre-configured with
`auth: "subscription"` and points to `api.anthropic.com`. Add it to your `model-map.overrides.json`
routes to enforce subscription-only billing.

---

## Auto-derived auth

Most endpoints in `config/model-map.json` no longer declare `auth_env` explicitly. The proxy
derives the outbound auth shape from the endpoint URL host using a built-in `KNOWN_HOSTS`
table (in `tools/claude-proxy`). Explicit declarations still win — they're just unnecessary
for the canonical providers.

| Host pattern | Derived profile | Outbound shape | Env var |
|---|---|---|---|
| `*.anthropic.com` | `bearer_priority` | Incoming Bearer wins; else `x-api-key` from env | `ANTHROPIC_API_KEY` |
| `*.openrouter.ai` | `header_env` | `Authorization: Bearer <env>` | `OPENROUTER_API_KEY` |
| `*.generativelanguage.googleapis.com` | `header_env` | `x-goog-api-key: <env>` | `GOOGLE_API_KEY` |
| `*.aiplatform.googleapis.com` (Vertex) | `header_env` | `Authorization: Bearer <env>` | `GOOGLE_CLOUD_TOKEN` |
| `localhost` / `127.0.0.1` | `none` | Passthrough; canonical Ollama (`:11434`) gets `Bearer ollama` injected | — |
| `*.ollama.ai` | `none` | Passthrough | — |

Endpoints whose host is **not** in the table fall through to `passthrough` (forward
incoming auth verbatim) and trigger a startup warning so silent misconfiguration is visible
before the first request 401s.

### Overriding the derived profile

Three endpoint-level overrides let you customize without leaving the auto-auth path:

| Field | Purpose |
|---|---|
| `auth_profile` | Explicitly choose `bearer_priority` \| `header_env` \| `passthrough` (skip host derivation) |
| `auth_header` | Override the outbound header name (e.g. `x-internal-key`) |
| `auth_scheme` | Override the prefix (`Bearer`, empty string for raw value, etc.) |
| `auth_env` | Pin the env var to read (defaults to the host-derived one) |

Hard policies (`auth: "subscription"` / `"none"`) and the existing `auth: { header, scheme, env }`
object syntax are unchanged — they short-circuit the derivation entirely.

### Verifying the chosen profile

Every successful response includes `x-c-thru-auth-derived: <profile>`. Use it to debug
"why is my key not being sent?":

```sh
curl -sI http://127.0.0.1:$CLAUDE_PROXY_PORT/v1/messages -X POST \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i x-c-thru-auth-derived
```

For end-to-end verification of subscription mode, shell out to the real `c-thru` binary
(which sets `ANTHROPIC_AUTH_TOKEN` from `claude login` and routes through the live proxy)
rather than the in-test stub:

```sh
~/.claude/tools/c-thru list                   # confirm anthropic_subscription is wired
ANTHROPIC_API_KEY= c-thru                     # force subscription-only path
```
