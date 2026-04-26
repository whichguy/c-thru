#!/usr/bin/env bash
# Tests for preflight_model_readiness() in tools/c-thru.
# Uses stub HTTP servers (node one-liners) to mock the proxy /v1/active-models
# endpoint and Ollama /api/tags endpoint without requiring real services.
#
# Run: bash test/preflight-model-readiness.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_DIR/test/helpers.sh"

WORK=$(mktemp -d)
trap 'kill_stubs; rm -rf "$WORK"' EXIT

# ── Stub server infrastructure ─────────────────────────────────────────────

STUB_PIDS=()

kill_stubs() {
  local pid
  for pid in "${STUB_PIDS[@]+"${STUB_PIDS[@]}"}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  STUB_PIDS=()
}

# start_stub_server <port> <response_body> [content-type]
# Starts a minimal node HTTP server that always responds with the given body.
start_stub_server() {
  local port="$1" body="$2" ct="${3:-application/json}"
  node -e "
    const http = require('http');
    const body = $(printf '%s' "$body" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8')))");
    http.createServer((req,res) => {
      res.writeHead(200, {'Content-Type': '$ct'});
      res.end(body);
    }).listen($port, '127.0.0.1', () => {});
  " &
  local pid=$!
  STUB_PIDS+=("$pid")
  # Wait for port to be ready (up to 2s)
  local i=0
  while ! curl -sf --max-time 2.0 "http://127.0.0.1:$port/" >/dev/null 2>&1; do
    sleep 0.1; i=$((i+1))
    [ $i -lt 20 ] || { echo "start_stub_server: timed out on port $port" >&2; return 1; }
  done
}

# Pick free ports using node
pick_port() { node -e "
  const net=require('net');
  const s=net.createServer();
  s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()});
"; }

# ── Extract the function under test ───────────────────────────────────────
# We source a wrapper that defines only the function, not the rest of c-thru.
# The function uses: curl, jq/node, OLLAMA_URL env var.

WRAPPER="$WORK/preflight_wrapper.sh"
cat > "$WRAPPER" <<'WRAPEOF'
#!/usr/bin/env bash
set -uo pipefail

# Inline copy of preflight_model_readiness routing skeleton from tools/c-thru.
# Kept in sync with tools/c-thru by contract-check Check 10 (c-thru-contract-check.sh).
# Only the action block differs: real pull/warm replaced with echo "PULL:<model>" for testability.
preflight_model_readiness() {
  local port="${1:-}"
  [[ "${C_THRU_SKIP_PREFLIGHT:-0}" == "1" ]] && return 0
  [[ -n "$port" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  local response
  response=$(curl -sf --max-time 3 "http://127.0.0.1:$port/v1/active-models" 2>/dev/null) || return 0
  [[ -n "$response" ]] || return 0

  local required_models
  if command -v jq >/dev/null 2>&1; then
    required_models=$(printf '%s' "$response" | jq -r '.local_models[]' 2>/dev/null) || return 0
  elif command -v node >/dev/null 2>&1; then
    required_models=$(node -e "
      try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
          d.local_models.forEach(m=>console.log(m));}catch{}" <<< "$response" 2>/dev/null) || return 0
  else
    return 0
  fi
  [[ -n "$required_models" ]] || return 0

  local ollama_base="${OLLAMA_URL:-http://localhost:11434}"
  local pulled_json pulled_models
  pulled_json=$(curl -sf --max-time 3 "${ollama_base%/}/api/tags" 2>/dev/null) || return 0
  if command -v jq >/dev/null 2>&1; then
    pulled_models=$(printf '%s' "$pulled_json" | jq -r '.models[].name' 2>/dev/null || true)
  else
    pulled_models=$(node -e "
      try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
          d.models.forEach(m=>console.log(m.name));}catch{}" <<< "$pulled_json" 2>/dev/null || true)
  fi

  local any_missing=0
  while IFS= read -r model; do
    [[ -n "$model" ]] || continue
    local bare_model="${model%%@*}"
    if ! printf '%s\n' "$pulled_models" | grep -qxF "$bare_model"; then
      any_missing=1
      echo "PULL:$bare_model"
    fi
  done <<< "$required_models"
  [[ "$any_missing" -eq 0 ]] || true
}

# Run with args: preflight_model_readiness $PROXY_PORT
# OLLAMA_URL and C_THRU_SKIP_PREFLIGHT are read from env.
preflight_model_readiness "${1:-}"
WRAPEOF

# Simplified wrapper: replaces the curl pull/warm block with a plain PULL: line
# so tests can assert which models were pulled without actually calling Ollama.
run_preflight() {
  local proxy_port="${1:-}" ollama_port="${2:-}"
  if [ -n "$ollama_port" ]; then
    OLLAMA_URL="http://127.0.0.1:$ollama_port" bash "$WRAPPER" "$proxy_port" 2>/dev/null
  else
    bash "$WRAPPER" "$proxy_port" 2>/dev/null
  fi
}

# ── Tests ──────────────────────────────────────────────────────────────────

# ── Test 1: all models already pulled — no PULL output ────────────────────
echo "Test 1: all models already pulled — no output"
P=$(pick_port); O=$(pick_port)
start_stub_server "$P" '{"tier":"64gb","mode":"connected","local_models":["modelA:7b","modelB:13b"]}'
start_stub_server "$O" '{"models":[{"name":"modelA:7b"},{"name":"modelB:13b"},{"name":"other:1b"}]}'
output=$(run_preflight "$P" "$O")
check "all-present: no PULL output" "" "$output"
kill_stubs; STUB_PIDS=()

# ── Test 2: one model missing — PULL output for that model ────────────────
echo "Test 2: one model missing — PULL emitted"
P=$(pick_port); O=$(pick_port)
start_stub_server "$P" '{"tier":"64gb","mode":"connected","local_models":["modelA:7b","missing:30b"]}'
start_stub_server "$O" '{"models":[{"name":"modelA:7b"}]}'
output=$(run_preflight "$P" "$O")
check "missing model: PULL:missing:30b emitted" "PULL:missing:30b" "$output"
kill_stubs; STUB_PIDS=()

# ── Test 3: all models missing — PULL for each ────────────────────────────
echo "Test 3: all models missing — PULL for each"
P=$(pick_port); O=$(pick_port)
start_stub_server "$P" '{"tier":"64gb","mode":"offline","local_models":["x:7b","y:13b"]}'
start_stub_server "$O" '{"models":[]}'
output=$(run_preflight "$P" "$O")
check "all-missing: PULL:x:7b present" "1" "$(echo "$output" | grep -c 'PULL:x:7b' || true)"
check "all-missing: PULL:y:13b present" "1" "$(echo "$output" | grep -c 'PULL:y:13b' || true)"
kill_stubs; STUB_PIDS=()

# ── Test 4: C_THRU_SKIP_PREFLIGHT=1 — no calls made ──────────────────────
echo "Test 4: C_THRU_SKIP_PREFLIGHT=1 — skipped entirely"
P=$(pick_port); O=$(pick_port)
start_stub_server "$P" '{"tier":"64gb","mode":"connected","local_models":["gone:99b"]}'
start_stub_server "$O" '{"models":[]}'
output=$(C_THRU_SKIP_PREFLIGHT=1 run_preflight "$P" "$O")
check "skip-preflight: no PULL output" "" "$output"
kill_stubs; STUB_PIDS=()

# ── Test 5: empty proxy port — silently skips ─────────────────────────────
echo "Test 5: empty port — silently returns"
output=$(run_preflight "" "")
check "empty-port: no output" "" "$output"

# ── Test 6: proxy unreachable — silently skips ────────────────────────────
echo "Test 6: proxy unreachable — silently returns"
output=$(run_preflight "19999" "")
check "proxy-unreachable: no output" "" "$output"

# ── Test 7: Ollama unreachable — silently skips ───────────────────────────
echo "Test 7: Ollama unreachable — silently returns"
P=$(pick_port)
start_stub_server "$P" '{"tier":"64gb","mode":"connected","local_models":["model:7b"]}'
output=$(OLLAMA_URL="http://127.0.0.1:19999" run_preflight "$P" "")
check "ollama-unreachable: no output" "" "$output"
kill_stubs; STUB_PIDS=()

# ── Test 8: no local_models in response — silently skips ──────────────────
echo "Test 8: empty local_models array — nothing to pull"
P=$(pick_port); O=$(pick_port)
start_stub_server "$P" '{"tier":"64gb","mode":"connected","local_models":[]}'
start_stub_server "$O" '{"models":[]}'
output=$(run_preflight "$P" "$O")
check "empty-local-models: no PULL" "" "$output"
kill_stubs; STUB_PIDS=()

# ── Test 9: @backend sigil stripped from model name ───────────────────────
echo "Test 9: @backend sigil stripped before comparing"
P=$(pick_port); O=$(pick_port)
# Proxy returns model with @stub sigil; Ollama reports the bare name as missing
start_stub_server "$P" '{"tier":"64gb","mode":"connected","local_models":["model:7b@stub"]}'
start_stub_server "$O" '{"models":[]}'
output=$(run_preflight "$P" "$O")
# Should strip @stub and pull bare "model:7b"
check "sigil-stripped: PULL:model:7b" "PULL:model:7b" "$output"
kill_stubs; STUB_PIDS=()

# ── Test 10: cloud-only session — no local_models — skips pull ────────────
echo "Test 10: cloud-only session (no local models)"
P=$(pick_port); O=$(pick_port)
start_stub_server "$P" '{"tier":"48gb","mode":"connected","local_models":[]}'
start_stub_server "$O" '{"models":[]}'
output=$(run_preflight "$P" "$O")
check "cloud-only: no PULL" "" "$output"
kill_stubs; STUB_PIDS=()

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
