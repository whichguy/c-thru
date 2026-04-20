#!/usr/bin/env bash
# Spike script: verify LM Studio Ollama-compat endpoint compatibility with claude-proxy.
#
# The proxy's kind:"ollama" path (forwardOllamaPassthrough) forwards the
# original request path unchanged. Claude Code sends Anthropic-format requests
# to /v1/messages. Ollama ≥0.6 accepts this natively. LM Studio's Ollama-compat
# layer may only support /v1/chat/completions (OpenAI format) — this script
# determines which is true and whether kind:"ollama" or kind:"openai" is needed.
#
# Prerequisites:
#   - LM Studio running with "Ollama-compatible API" enabled in settings
#   - At least one model loaded in LM Studio
#   - Default LM Studio port: 1234
#
# Usage:
#   bash tools/verify-lmstudio-ollama-compat.sh [host:port]
#   bash tools/verify-lmstudio-ollama-compat.sh localhost:1234   # default

set -euo pipefail

HOST="${1:-localhost:1234}"
BASE="http://$HOST"
PASS=0
FAIL=0
SKIP=0

ok()   { echo "  PASS  $*"; ((PASS++)) || true; }
fail() { echo "  FAIL  $*"; ((FAIL++)) || true; }
skip() { echo "  SKIP  $*"; ((SKIP++)) || true; }
info() { echo "  ----  $*"; }

echo "LM Studio Ollama-compat spike — $BASE"
echo ""

# ── 1. Reachability ───────────────────────────────────────────────────
echo "1. Reachability"
if ! curl -sf --max-time 3 "$BASE/api/tags" >/dev/null 2>&1; then
  echo "  FATAL: $BASE/api/tags unreachable — is LM Studio running with Ollama API enabled?"
  exit 1
fi
ok "/api/tags reachable"

# ── 2. /api/tags response shape ───────────────────────────────────────
echo ""
echo "2. /api/tags response shape (Ollama: {models:[{name,...}]})"
tags_body="$(curl -sf --max-time 3 "$BASE/api/tags")"
if echo "$tags_body" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'models' in d and isinstance(d['models'], list)" 2>/dev/null; then
  ok "/api/tags returns {models:[...]}"
  first_model="$(echo "$tags_body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['models'][0]['name'] if d['models'] else '')" 2>/dev/null || true)"
  [[ -n "$first_model" ]] && info "First model: $first_model" || info "No models loaded"
else
  fail "/api/tags shape mismatch — expected {models:[{name,...}]}"
  first_model=""
fi

# ── 3. /api/generate warmup call (used by proxy for liveness probe) ──
echo ""
echo "3. /api/generate warmup call (proxy uses this for Ollama liveness probe)"
if [[ -n "$first_model" ]]; then
  gen_resp="$(curl -sf --max-time 10 -X POST "$BASE/api/generate" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$first_model\",\"prompt\":\"\",\"stream\":false}" 2>&1 || echo "ERROR")"
  if echo "$gen_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'response' in d or 'model' in d" 2>/dev/null; then
    ok "/api/generate returns valid JSON with response or model field"
  else
    fail "/api/generate unexpected response: ${gen_resp:0:200}"
    info "NOTE: proxy warmup probe uses /api/generate — failure means liveness check will mark backend dead"
  fi
else
  skip "/api/generate — no models loaded to test with"
fi

# ── 4. KEY TEST: /v1/messages (Anthropic format) ──────────────────────
echo ""
echo "4. KEY: /v1/messages Anthropic-format endpoint (kind:\"ollama\" requires this)"
if [[ -n "$first_model" ]]; then
  anthropic_body="{\"model\":\"$first_model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
  msg_resp="$(curl -sf --max-time 15 -X POST "$BASE/v1/messages" \
    -H 'content-type: application/json' \
    -H 'x-api-key: test' \
    -H 'anthropic-version: 2023-06-01' \
    -d "$anthropic_body" 2>&1 || echo "ERROR")"
  if echo "$msg_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('type') == 'message' or 'content' in d" 2>/dev/null; then
    ok "/v1/messages returns Anthropic-format response → kind:\"ollama\" WORKS with LM Studio"
  else
    fail "/v1/messages not supported → kind:\"ollama\" will NOT work; use kind:\"openai\" instead"
    info "Response: ${msg_resp:0:200}"
    info "ACTION: add lmstudio_local backend with kind:\"openai\" and url:\"$BASE\""
    info "        The OpenAI-compat /v1/chat/completions path requires full protocol translation"
    info "        (kind:\"openai\" in c-thru — currently deferred per plan §3)"
  fi
else
  skip "/v1/messages — no models loaded to test with"
fi

# ── 5. /v1/chat/completions (OpenAI format — what LM Studio natively serves) ─
echo ""
echo "5. /v1/chat/completions OpenAI-format (for reference — kind:\"openai\" path)"
if [[ -n "$first_model" ]]; then
  oai_body="{\"model\":\"$first_model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
  oai_resp="$(curl -sf --max-time 15 -X POST "$BASE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer test' \
    -d "$oai_body" 2>&1 || echo "ERROR")"
  if echo "$oai_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'choices' in d" 2>/dev/null; then
    ok "/v1/chat/completions returns OpenAI-format response"
  else
    fail "/v1/chat/completions unexpected: ${oai_resp:0:200}"
  fi
else
  skip "/v1/chat/completions — no models loaded"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "$((PASS + FAIL + SKIP)) checks: $PASS passed, $FAIL failed, $SKIP skipped"
echo ""
if [[ $FAIL -eq 0 && $SKIP -eq 0 ]]; then
  echo "RESULT: LM Studio is Ollama-compat — use kind:\"ollama\" for lmstudio_local backend."
  echo "        Add to model-map.json:"
  echo "          \"lmstudio_local\": { \"kind\": \"ollama\", \"url\": \"$BASE\" }"
elif echo "$gen_resp ${msg_resp:-}" | grep -q "FAIL\|ERROR" 2>/dev/null; then
  echo "RESULT: /v1/messages not supported. LM Studio only speaks OpenAI format."
  echo "        kind:\"openai\" is required (full protocol translation — deferred in plan §3)."
  echo "        Until kind:\"openai\" is implemented, use OpenRouter as the cloud proxy instead."
fi

exit $([[ $FAIL -eq 0 ]] && echo 0 || echo 1)
