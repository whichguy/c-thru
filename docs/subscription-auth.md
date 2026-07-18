# Subscription Auth — Using Your Account Subscriptions with c-thru

c-thru supports routing requests through provider subscriptions rather than pay-per-token
API keys. This page explains what's available per provider and how to configure it.

---

## TL;DR per provider

| Provider | Subscription → API path? | How |
|---|---|---|
| **Claude / Anthropic** | Yes | `claude login` sets `ANTHROPIC_AUTH_TOKEN`; c-thru routes via subscription credits |
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
`~/.claude/.credentials.json`. c-thru never exports a placeholder
`ANTHROPIC_AUTH_TOKEN` of its own, so Claude Code's OAuth flow runs end-to-end and the
proxy forwards the resulting Bearer to Anthropic. The proxy also strips stray
`x-api-key` headers whenever a Bearer token is being forwarded — so requests charge
your subscription rather than getting double-billed against an API key.

```sh
claude login               # authenticate — stores OAuth in Keychain (macOS) or ~/.claude/.credentials.json (Linux)
unset ANTHROPIC_API_KEY    # optional: prevent accidental API billing if both are set
c-thru                     # requests now use subscription billing
```

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

```sh
c-thru list   # shows active route; Bearer = subscription, x-api-key = API billing
```

The response header `x-c-thru-resolved-via` shows `served_by` and includes `auth_missing`
when no valid auth was found.

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
