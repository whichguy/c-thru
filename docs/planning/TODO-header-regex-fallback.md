# TODO: Header-regex fallback conditions and request header overrides

## Idea

Two related mechanisms for the proxy's fallback/routing layer:

### 1. Response-header regex → fallback trigger

Today fallback conditions are failure-class based (connection refused, timeout,
4xx/5xx status codes). Extend `fallback_strategies` so a route can declare
regex patterns against *response headers* as additional failure conditions:

```json
"fallback_strategies": {
  "workhorse": {
    "event": {
      "header_mismatch": [
        {"header": "x-backend-model", "pattern": "^(?!qwen3)", "fallback": ["qwen3:35b"]}
      ]
    }
  }
}
```

When the upstream response returns a header matching (or failing to match) a
pattern, treat it as a named failure class and walk the fallback chain.

Use cases:
- Ollama or an OpenRouter upstream echoes which model actually served the
  request. If the echo doesn't match what was requested (e.g. a remote proxy
  silently downgraded), trigger a retry on a different backend.
- A reverse-proxy injects `x-ratelimit-remaining: 0` — pattern on that to
  preemptively reroute before the 429 lands.
- Vendor-specific headers (e.g. `cf-cache-status: MISS` on a caching proxy)
  used as routing signals.

### 2. Request header injection / override by route

Allow `model-map.json` routes to declare header overrides that the proxy
injects (or strips) on outbound requests:

```json
"routes": {
  "high-model": {
    "model": "gemma4:26b",
    "backend": "ollama-local",
    "request_headers": {
      "x-priority": "high",
      "authorization": null
    }
  }
}
```

`null` value means strip the header. String value means set/override.
Pattern: apply after the Anthropic→Ollama translation, before forwarding.

Use cases:
- Inject API keys per-route for multi-tenant OpenRouter backends.
- Strip or rewrite `authorization` when forwarding to an unauthenticated
  local backend.
- Add tracing headers (e.g. `x-trace-id`) per route for observability.

## Open questions

- For response-header matching: does the proxy have reliable access to
  *all* upstream headers in the current SSE/streaming path, or only on
  the first chunk? (Need to verify `forwardOllama`/`forwardAnthropic`
  response header handling.)
- For request header injection: should overrides apply only to the first
  attempt or also to fallback hops? (Probably: yes to both, but the route
  that fires the injection is the *original* route, not the fallback target.)
- Header regex patterns: use the same `re:` prefix convention as
  `model_routes` pattern keys, or a dedicated `pattern` field?
- Security: if a request comes in with a header that a route would inject,
  does the proxy honor the client's value or always override? (Safer: always
  override for security-sensitive headers like `authorization`.)

## Touch points

- `tools/claude-proxy` — `forwardOllama`, `forwardAnthropic`: add header
  injection before forwarding; read response headers for condition matching.
- `tools/claude-proxy` — `handleRequestWithFallback`: add new failure class
  `header_mismatch` alongside existing ones; trigger chain walk.
- `tools/model-map-validate.js` — extend schema validation for new fields.
- `config/model-map.json` — document new fields in comments.

## Status

Queued.
