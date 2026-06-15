# Design Spec — AWS Bedrock as a c-thru backend

**Status: PROPOSED — design only, not implemented.** Tasks #20/#21.
Build is deferred; this doc is the contract a future implementation must satisfy.

> Premise verified live (2026-06-14): **Bedrock is entirely greenfield.** A full
> repo grep for `bedrock|BEDROCK|sigv4|SigV4|Converse|InvokeModel|AWS_BEARER_TOKEN_BEDROCK`
> finds **no functional code** — only 2 inert comment mentions (`tools/claude-proxy:126`
> fallback-chain example, `tools/c-thru:4` supported-backends banner) plus doc mentions
> (`docs/functionality-map.md:108,257`). No scaffolding exists to reconcile against.
> (Note: the `tools/c-thru:14` help line `c-thru --model bedrock-opus — Bedrock (from
> model-map.json)` is stale — no `bedrock` endpoint exists in `config/model-map.json` today.)

---

## 1. Goal & scope

Let c-thru route Claude Code (and any Anthropic-Messages client behind the proxy) to
Anthropic models **hosted on AWS Bedrock**, selected by the same model-map machinery that
already routes to Anthropic-cloud, OpenRouter, Ollama, and Gemini. Two requirements drive
the design:

1. **Task #20 — the default-URL rule.** When a Bedrock override is in force (a Bedrock
   endpoint is the resolved backend for the active route, whether that resolution comes from
   `config/model-map.json` or from environment rules), the **effective default
   `ANTHROPIC_BASE_URL` must point at the Bedrock endpoint, not the commercial Anthropic
   URL.** Today the launcher only diverts to the proxy for `ollama`/`gemini`/localhost-anthropic
   and otherwise sends cloud Anthropic straight to `https://api.anthropic.com`
   (`tools/c-thru:apply_resolved_backend` 4376–4407). A Bedrock route must never silently
   fall through to the commercial URL.
2. **Injection ethos (the standing design principle).** Backend selection and auth must come
   through the **inline/ephemeral** channels c-thru already uses — endpoint config + per-route
   env (`ANTHROPIC_BASE_URL`, an `auth_env`-named token, the endpoint `env{}` block) and the
   proxy's per-request dispatch — **not** a written-to-disk `backend.env`, profile mutation, or
   AWS credentials file managed by c-thru. c-thru *reads* ambient AWS creds; it does not author
   credential files.

Out of scope (explicitly deferred): streaming-token cost accounting specific to Bedrock,
provisioned-throughput ARNs, Bedrock Guardrails, and any non-Anthropic Bedrock model family.

---

## 2. Two implementation paths (decide before building)

Bedrock natively speaks the **Anthropic Messages schema** — on Bedrock the request body *is*
an Anthropic body (minus the top-level `model`, plus an `anthropic_version`), reached via
`InvokeModel`/`InvokeModelWithResponseStream` on a region host. This makes Bedrock
fundamentally cheaper to add than Gemini was: the **body barely changes**; the work is
**URL shape + auth + SSE envelope**, not a full request/response translator.

### Path A — Native Claude Code Bedrock (thin; env-injection only)

Claude Code already supports Bedrock directly via `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds.
c-thru's job shrinks to: detect a Bedrock-resolved route, **not** spawn the translating proxy,
and inject `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, and the model→Bedrock-modelId mapping as
**inline env**, then exec `claude` un-proxied.

- **Pro:** almost no proxy code; rides Anthropic's maintained Bedrock client; conforms hardest
  to the inline-injection ethos.
- **Con:** bypasses the proxy, so c-thru's unified journaling, fallback-chain, and
  `x-c-thru-*` headers do **not** apply to Bedrock traffic; only the `claude` CLI benefits (a
  raw SDK client pointed at the proxy would not reach Bedrock).
- **#20 rule under Path A:** satisfied by *not* setting `ANTHROPIC_BASE_URL` to the commercial
  URL at all — `CLAUDE_CODE_USE_BEDROCK=1` makes Claude Code derive the Bedrock regional host
  itself. The launcher must ensure no stale `ANTHROPIC_BASE_URL` leaks into the Bedrock exec.

### Path B — Proxy-translated Bedrock (unified; recommended)

The proxy intercepts the Anthropic Messages request and forwards it to Bedrock's
`InvokeModel`/`InvokeModelWithResponseStream`, adapting URL + auth + the SSE framing, keeping
Bedrock inside c-thru's routing/journaling/fallback model exactly like every other backend.

- **Pro:** Bedrock becomes a first-class peer of the other endpoints; one code path for
  routing, fallback (`fallback_to`), usage journaling, and headers; works for any
  Anthropic-Messages client, not just `claude`.
- **Con:** the proxy must own SigV4 (or bearer) signing and the Bedrock SSE envelope
  (AWS event-stream `application/vnd.amazon.eventstream`, **not** raw `text/event-stream`).
- **#20 rule under Path B:** the launcher routes Bedrock through the proxy (as it does Ollama /
  Gemini), so `ANTHROPIC_BASE_URL` points at the **local proxy**, and the proxy's
  `resolveBackend` carries the Bedrock endpoint — the commercial URL is never used.

**Recommendation: Path B**, because c-thru's entire value proposition is the unified proxy
plane (journaling, fallback chains, headers). Path A is the documented escape hatch for users
who only run `claude` and want the lightest possible setup; the spec keeps it as a supported
mode toggled by an endpoint field (`call_style: "bedrock-native"` → Path A;
`call_style: "bedrock"` → Path B).

---

## 3. Endpoint config schema

Add a Bedrock endpoint to `config/model-map.json` `endpoints{}` using the **existing field
vocabulary** — these fields already exist, but they are consumed in different places, and one
schema change is still required:

- `format`/`call_style`/`auth` are normalized by `tools/claude-proxy:normalizeBackend`
  (707–735); `auth_env` is read by `isAuthMissing` (`claude-proxy:825–833`) and
  `applyOutboundAuth` (912/931); the endpoint `env{}` block is honored **only** by the
  launcher's `apply_provider_block` (`tools/c-thru:4353–4357`), **never** by the proxy.
- **Schema change required:** `VALID_CALL_STYLES` (`tools/claude-proxy:699`) is currently
  `{anthropic, gemini, openai}`, so `normalizeBackend` (728–733) would **warn-and-drop** the
  new `"bedrock"`/`"bedrock-native"` values below. The set must gain both tokens before this
  schema works — see §7 step 0.

```jsonc
"endpoints": {
  "bedrock": {
    "url": "https://bedrock-runtime.${AWS_REGION}.amazonaws.com",
    "format": "bedrock",
    "call_style": "bedrock",                 // "bedrock-native" selects Path A
    "auth": {
      "mode": "sigv4",                        // "sigv4" | "bearer"
      "service": "bedrock",
      "region_env": "AWS_REGION"
    },
    "auth_env": "AWS_BEARER_TOKEN_BEDROCK",   // used only when auth.mode == "bearer"
    "model_id_map": {                          // Anthropic model name → Bedrock modelId / inference-profile id
      "claude-opus-4-8":   "us.anthropic.claude-opus-4-8-v1:0",
      "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6-v1:0"
    },
    "fallback_to": "claude-sonnet-4-6"         // existing field: cloud fallback on Bedrock failure
  }
}
```

**New endpoint fields this introduces** (additive — every existing endpoint omits them):
- `format: "bedrock"` / `call_style: "bedrock" | "bedrock-native"` — the dispatch discriminator.
- `auth.mode` — `sigv4` (sign each request with AWS SigV4 from ambient creds) or `bearer`
  (send `Authorization: Bearer ${AWS_BEARER_TOKEN_BEDROCK}`, AWS's API-key-style token).
- `auth.service` / `auth.region_env` — SigV4 signing inputs.
- `model_id_map` — Anthropic route name → Bedrock `modelId`. Bedrock model IDs differ from
  Anthropic's and are **region/inference-profile-prefixed** (e.g. `us.anthropic.…`). A route
  with no `model_id_map` entry is a **hard config error** at validate time (see §6), not a
  silent passthrough — a raw Anthropic name is not a valid Bedrock modelId.

### Regional URL

Bedrock runtime host is region-scoped:
`https://bedrock-runtime.<region>.amazonaws.com`. Region resolution precedence (highest first):
`AWS_REGION` → `AWS_DEFAULT_REGION` → endpoint `auth.region_env` default → **error if unset**
(unlike Vertex, which today emits a soft warning for unset `${GOOGLE_CLOUD_REGION}` and lets a
malformed URL through — Bedrock must hard-fail, because an unsigned/region-less request leaks
nothing useful and wastes a round-trip). The `${AWS_REGION}` template in `url` is expanded by
the same `backendHost` env-interpolation path that handles `${GOOGLE_CLOUD_REGION}` today
(`tools/claude-proxy:811`).

---

## 4. Launcher integration (`tools/c-thru`)

The Bedrock arm goes in `apply_resolved_backend` (4376–4407), which classifies by
`format // kind // "anthropic"` and dispatches proxy-vs-direct — **but the change is not
localized to that function alone** (see the dispatch-gate caveat below).

Add a Bedrock arm **before** the generic cloud-direct `else`:

- `call_style == "bedrock"` (Path B) → route **through the proxy**, exactly like the
  `ollama`/`gemini` arm: spawn/ensure the proxy, set `ANTHROPIC_BASE_URL` to the proxy base
  (`apply_ollama_client_block "$ENSURED_PROXY_HTTP_BASE" …`). This is where the **#20 rule** is
  mechanically enforced — *once the dispatch gate admits Bedrock* (see caveat below): a Bedrock
  route then can never reach `apply_provider_block "$BASE_URL" …` with the commercial Anthropic URL.
- `call_style == "bedrock-native"` (Path A) → **do not** spawn the proxy; export
  `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` (+ the resolved `modelId` via Claude Code's
  Bedrock model env, e.g. `ANTHROPIC_MODEL`) through the existing endpoint `env{}` mechanism
  (`apply_provider_block`'s env-export loop, 4354–4357) and **unset/avoid** `ANTHROPIC_BASE_URL`.
- **Auth bootstrap:** mirror the Gemini `bootstrap_endpoint_auth_env` pattern (4382–4389). For
  `auth.mode == "bearer"`, require `AWS_BEARER_TOKEN_BEDROCK`; for `sigv4`, require resolvable
  ambient AWS creds (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY[/AWS_SESSION_TOKEN]` or a
  resolvable profile/role) — **refuse to dispatch** with a clear stderr message if neither
  auth path is satisfiable, matching the existing "refusing to dispatch … without $AUTH_ENV"
  behavior.

No change to `apply_provider_block` itself for Path B; Path A reuses its `env{}` export loop.

> **Dispatch-gate caveat — the change is _not_ localized to `apply_resolved_backend`.** The
> `targets{}` resolution path runs **before** `model_routes`: `resolve_target_backend_for_model`
> (def `tools/c-thru:1461`, called at 4419) sets `TARGET_FORCE_PROXY=1`, and the block at 4428
> gates entry to `apply_resolved_backend` behind a **format allowlist at 4443–4444** that admits
> only `ollama | gemini | anthropic+localhost/127.0.0.1`. A `format:"bedrock"` backend resolved
> via `targets{}` falls to the `else` at 4447 → `apply_proxy_fallback_client_block` and **never
> enters the Bedrock arm above.** Consequence splits by path: **Path B** (proxy) still proxies, so
> the #20 no-leak rule holds *incidentally*; but **Path A (`bedrock-native`) is actively wrong** —
> the 4447 fallthrough spawns a proxy that Path A forbids. Therefore the build must add
> `bedrock`/`bedrock-native` to **both** the `targets{}` allowlist (4443–4444) **and** the
> symmetric allowlist inside `apply_resolved_backend` (≈4392), not only insert an arm. The §1 #20
> claim "a Bedrock route can never reach `apply_provider_block` with the commercial Anthropic URL"
> holds only once both allowlists admit Bedrock.

---

## 5. Proxy integration (`tools/claude-proxy`) — Path B only

### 5.1 Dispatch branch

In the per-request dispatch (4838–4857), add a Bedrock arm beside the Gemini/openai arms:

```js
if (backend.call_style === 'bedrock') {
  return dispatchBedrockBackend(ctx, req, res, body, backend, effectiveModel, requestMeta);
}
```

placed before the `forwardAnthropic` passthrough default. `resolveBackend` (975–1097) needs no
change — it already normalizes any endpoint and supports the `@backend` sigil
(`claude-opus-4-8@bedrock`) and `fallback_to`.

### 5.2 Request translation (lighter than Gemini)

`dispatchBedrockBackend` adapts an Anthropic Messages request to Bedrock `InvokeModel`:

- **URL/path:** `POST /model/{modelId}/invoke` (non-stream) or
  `/model/{modelId}/invoke-with-response-stream` (stream), where `{modelId}` is the
  url-encoded `model_id_map[effectiveModel]`. Host from §3.
- **Body:** take the incoming Anthropic body, **remove the top-level `model`** (it moves into
  the path) and **inject `anthropic_version: "bedrock-2023-05-31"`**. `messages`, `system`,
  `tools`, `tool_choice`, `max_tokens`, `temperature`, `stop_sequences` pass through unchanged
  — this is the key economy vs the Gemini translator, which had to remap tool shapes and roles.
- **Headers:** drop Anthropic auth headers (`x-api-key`, `anthropic-*`); attach AWS auth (§5.3);
  `content-type: application/json`; `accept` per stream mode.

### 5.3 Auth

Extend the auth layer (`applyOutboundAuth` 845–973; `deriveAuthProfile`/KNOWN_HOSTS 791–820):

- **`bearer` mode:** add a KNOWN_HOSTS entry for `*.amazonaws.com` Bedrock (or honor explicit
  `auth.mode`) producing `Authorization: Bearer ${AWS_BEARER_TOKEN_BEDROCK}`. This rides the
  existing `header_env` profile with near-zero new code — the AWS Bedrock API-key bearer token
  is the low-friction path and should be the **default recommended** auth for v1.
- **`sigv4` mode:** the one genuinely new primitive — a SigV4 signer (service `bedrock`, region
  from §3, signing the method/path/headers/body hash) computing the
  `Authorization: AWS4-HMAC-SHA256 …` + `X-Amz-Date` (+ `X-Amz-Security-Token` when a session
  token is present). Implement as a self-contained helper invoked from `dispatchBedrockBackend`
  *after* the body is finalized (SigV4 signs the exact payload bytes). Keep it dependency-free
  (Node `crypto`) to preserve the proxy's zero-dependency posture. **v1 may ship `bearer` only**
  and stub `sigv4` with a 501-style clear error, mirroring the openai stub precedent
  (4844–4849) — but the config schema must accept `sigv4` from day one so users don't re-plumb.

### 5.4 Response translation (the real work)

Bedrock streaming is **AWS event-stream framed** (`application/vnd.amazon.eventstream`:
length-prefixed binary frames with CRC), **not** raw SSE. `dispatchBedrockBackend` must:

- **Non-stream:** the `InvokeModel` response body **is already** the Anthropic
  `messages`-shaped payload — there is no enclosing envelope to unwrap; this is mostly a
  passthrough of the decoded body + restoring the top-level `model`.
- **Stream:** decode the binary event-stream frames and **re-emit them as Anthropic SSE**
  (`text/event-stream` with `message_start`/`content_block_delta`/… events) so the downstream
  Claude Code client — which only understands Anthropic SSE — sees a native stream. This event
  decoder is the single largest new component and the main reason Path B is "medium" not "small".

### 5.5 Usage journaling & headers

Once responses are normalized to the Anthropic shape, the existing `recordUsage` and
`x-c-thru-*` header paths apply unchanged — Bedrock usage shows up in the same journal as every
other backend, which is the whole point of choosing Path B.

---

## 6. Validation & corner cases (`tools/model-map-validate.js`)

- **Region required.** A `bedrock` endpoint whose region cannot resolve (`url` still contains an
  unexpanded `${AWS_REGION}` and no `AWS_REGION`/`AWS_DEFAULT_REGION` in env) → **hard error**,
  not the soft warning Vertex gets. Rationale: a region-less Bedrock URL can never succeed.
- **`model_id_map` completeness.** Every route that can resolve to the Bedrock endpoint
  (`model_routes` targets, `llm_profiles` entries, `@bedrock` sigils) must have a
  `model_id_map` entry, else the resolved request has no valid Bedrock `modelId`. Validate the
  map's keys against the routes that reach the endpoint; missing key → error citing the route.
- **Auth mutual-exclusion / presence.** `auth.mode: "bearer"` requires `AWS_BEARER_TOKEN_BEDROCK`
  resolvable; `auth.mode: "sigv4"` requires resolvable AWS creds. Validation warns (not errors)
  at config-check time (creds may be supplied at launch), but the **launcher** hard-refuses at
  dispatch (§4) — same split the rest of the system uses (validate warns on absent env; launch
  enforces).
- **`fallback_to` cycle safety.** Reuse the existing `tryFallbackOrFail` cycle protection;
  Bedrock→cloud fallback must not loop back into Bedrock. (Verify against the live fallback
  guard, named HIGH-priority in `docs/test-coverage-audit.md`.)
- **No commercial-URL leak (#20 regression guard).** Add a test asserting that resolving a
  Bedrock route yields `ANTHROPIC_BASE_URL` = proxy (Path B) or unset-with-`CLAUDE_CODE_USE_BEDROCK`
  (Path A), and **never** `https://api.anthropic.com`. This is the executable form of task #20.
- **Stream envelope mismatch.** Guard the decoder against a Bedrock response that returns JSON
  error bodies (throttling, `modelId` not found, region mismatch) instead of an event-stream —
  surface them as Anthropic-shaped errors, don't crash the frame parser.

---

## 7. Build checklist (when approved)

0. **Prereq (spec-level):** extend `VALID_CALL_STYLES` (`tools/claude-proxy:699`) to
   `{anthropic, gemini, openai, bedrock, bedrock-native}` so `normalizeBackend` stops
   warn-and-dropping the new call styles (§3).
1. `config/model-map.json` — add the `bedrock` endpoint (schema §3); mirror to plugin bundle via
   `tools/sync-plugin-bundle.sh`.
2. `tools/c-thru` — Bedrock arm in `apply_resolved_backend` (§4) **and** add `bedrock`/
   `bedrock-native` to both dispatch allowlists (the `targets{}` gate at 4443–4444 and the
   symmetric one at ≈4392 — see the §4 dispatch-gate caveat), with the #20 routing guarantee and
   auth bootstrap.
3. `tools/claude-proxy` — `dispatchBedrockBackend` (request adapt §5.2, auth §5.3, response/SSE
   decode §5.4) + the dispatch branch; `bearer` auth first, `sigv4` behind a stub-or-implement
   decision.
4. `tools/model-map-validate.js` — the §6 checks (region-required, `model_id_map` completeness,
   auth presence).
5. Tests — #20 no-leak regression, model-id mapping, fallback cycle, event-stream decode against
   recorded Bedrock frames; register in `test/run-all.sh` (env-gated — needs AWS creds/fixtures).
6. Docs — flip `docs/functionality-map.md:108,257` from "absent" to shipped; cross-link this spec;
   update `docs/connectivity-modes.md` and env-var docs with `AWS_REGION` / `AWS_BEARER_TOKEN_BEDROCK`
   / `CLAUDE_CODE_USE_BEDROCK`.

**Effort estimate:** Path B is **medium** — small launcher + config + validator changes, but the
event-stream→SSE decoder (§5.4) and SigV4 signer (§5.3) are the two real units of work. `bearer`
auth + non-streaming first would land a usable v1 quickly; streaming and SigV4 follow.
