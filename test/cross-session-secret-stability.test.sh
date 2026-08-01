#!/usr/bin/env bash
# P2 — fixed-proxy agent-token + control-token cross-session stability.
#
# Independent launcher sessions that reuse one fixed proxy must sign with the
# same distinct per-user agent token. The control token is stable separately.
#
# Run: bash test/cross-session-secret-stability.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTHRU="$REPO_DIR/tools/c-thru"
PROXY="$REPO_DIR/tools/claude-proxy"
[[ -f "$CTHRU" ]] || { echo "fatal: cannot find $CTHRU" >&2; exit 1; }
[[ -f "$PROXY" ]] || { echo "fatal: cannot find $PROXY" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "fatal: node required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "fatal: jq required" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL+1)); }
assert() { if eval "$1"; then pass "$2"; else fail "$2"; fi; }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-xsess-sec.XXXXXX")"
PROXY_PID=""
STUB_AGENT_PID=""
STUB_DEFAULT_PID=""
cleanup() {
  set +m 2>/dev/null
  for pid in "$PROXY_PID" "$STUB_AGENT_PID" "$STUB_DEFAULT_PID"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  rm -rf "$BASE"
}
trap cleanup EXIT

eval "$(awk '/^gen_secret_hex\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^ensure_agent_sentinel_secret\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^ensure_per_user_secrets\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^agent_sentinel_token_identity_version\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^agent_sentinel_token_fingerprint\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^require_proxy_agent_token_identity\(\) \{/,/^\}$/' "$CTHRU")"
type ensure_agent_sentinel_secret >/dev/null 2>&1 || { echo "fatal: ensure_agent_sentinel_secret not sourced" >&2; exit 1; }
type ensure_per_user_secrets >/dev/null 2>&1 || { echo "fatal: ensure_per_user_secrets not sourced" >&2; exit 1; }
type require_proxy_agent_token_identity >/dev/null 2>&1 || { echo "fatal: token identity verifier not sourced" >&2; exit 1; }

PROFILE="$BASE/profile"
export CLAUDE_PROFILE_DIR="$PROFILE"
HMAC_FILE="$PROFILE/agent-hmac.key"
TOKEN_FILE="$PROFILE/proxy.control-token"
AGENT_NAME="reviewer-plan"

echo "A. Session A: create in-memory sentinel secret + on-disk control token"
unset C_THRU_AGENT_SENTINEL_SECRET C_THRU_AGENT_SENTINEL_SECRET_FILE
ensure_agent_sentinel_secret
AGENT_TOKEN_FILE="$PROFILE/proxy.agent-token"
SECRET_A="$(cat "$AGENT_TOKEN_FILE")"
CLAUDE_PROFILE_DIR="$PROFILE" ensure_per_user_secrets
assert "[[ '$SECRET_A' =~ ^[0-9a-fA-F]{64}$ ]]" "session A has strong sentinel secret"
assert "[[ ! -e '$HMAC_FILE' ]]" "session A did not create retired agent-hmac.key"
assert "[[ -s '$TOKEN_FILE' ]]" "session A created proxy.control-token"
TOKEN_A="$(cat "$TOKEN_FILE")"

MARKER_A="$(C_THRU_AGENT_SENTINEL_SECRET="$SECRET_A" node -e '
  const {formatAgentSentinel}=require(process.argv[1]);
  process.stdout.write(formatAgentSentinel(process.argv[2], process.env.C_THRU_AGENT_SENTINEL_SECRET));
' "$REPO_DIR/tools/agent-sentinel.js" "$AGENT_NAME") go"

echo
echo "B. Session B: agent and control tokens stay stable for fixed-proxy reuse"
unset C_THRU_AGENT_SENTINEL_SECRET C_THRU_AGENT_SENTINEL_SECRET_FILE
ensure_agent_sentinel_secret
SECRET_B="$(cat "$AGENT_TOKEN_FILE")"
CLAUDE_PROFILE_DIR="$PROFILE" ensure_per_user_secrets
TOKEN_B="$(cat "$TOKEN_FILE")"
assert "[[ '$SECRET_A' == '$SECRET_B' ]]" "agent token STABLE across sessions"
assert "[[ '$TOKEN_A' == '$TOKEN_B' ]]" "proxy.control-token STABLE across sessions"
assert "[[ ! -e '$HMAC_FILE' ]]" "still no persisted agent-hmac.key after session B"
MARKER_B="$(C_THRU_AGENT_SENTINEL_SECRET="$SECRET_B" node -e '
  const {formatAgentSentinel}=require(process.argv[1]);
  process.stdout.write(formatAgentSentinel(process.argv[2], process.env.C_THRU_AGENT_SENTINEL_SECRET));
' "$REPO_DIR/tools/agent-sentinel.js" "$AGENT_NAME") go"

start_stub() {
  node -e '
    const http=require("http");
    const s=http.createServer((req,res)=>{
      let b=""; req.on("data",c=>b+=c); req.on("end",()=>{
        let m="stub"; try{ m=JSON.parse(b).model||"stub"; }catch{}
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({id:"msg",type:"message",role:"assistant",
          content:[{type:"text",text:"ok"}],model:m,stop_reason:"end_turn",
          stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));
      });
    });
    s.listen(0,"127.0.0.1",()=>{ require("fs").writeFileSync(process.argv[1], String(s.address().port)); });
  ' "$1" &
}
AGENT_PORT_FILE="$BASE/agent.port"
DEFAULT_PORT_FILE="$BASE/default.port"
start_stub "$AGENT_PORT_FILE";   STUB_AGENT_PID=$!
start_stub "$DEFAULT_PORT_FILE"; STUB_DEFAULT_PID=$!
for pf in "$AGENT_PORT_FILE" "$DEFAULT_PORT_FILE"; do
  for _ in $(seq 1 50); do [[ -s "$pf" ]] && break; sleep 0.1; done
done
AGENT_PORT="$(cat "$AGENT_PORT_FILE" 2>/dev/null)"
DEFAULT_PORT="$(cat "$DEFAULT_PORT_FILE" 2>/dev/null)"
assert "[[ -n '$AGENT_PORT' && -n '$DEFAULT_PORT' ]]" "stub backends bound"

CONFIG="$BASE/model-map.json"
cat > "$CONFIG" <<EOF
{
  "agent_to_capability": { "$AGENT_NAME": "plan-reviewer" },
  "llm_profiles": { "plan-reviewer": { "best-cloud": { "16gb": "agent-model" } } },
  "model_routes": { "agent-model": "agentBackend", "default-model": "defaultBackend" },
  "endpoints": {
    "agentBackend":   { "kind": "anthropic", "url": "http://127.0.0.1:$AGENT_PORT" },
    "defaultBackend": { "kind": "anthropic", "url": "http://127.0.0.1:$DEFAULT_PORT" }
  }
}
EOF

PROXY_OUT="$BASE/proxy.out"
PROXY_HOME="$BASE/proxy-home"; mkdir -p "$PROXY_HOME"
HOME="$PROXY_HOME" \
  CLAUDE_LLM_MODE=best-cloud \
  C_THRU_AGENT_SENTINEL_SECRET_FILE="$AGENT_TOKEN_FILE" \
  CLAUDE_PROXY_CONTROL_TOKEN_FILE="$TOKEN_FILE" \
  CLAUDE_PROXY_STARTUP_PROBE=0 \
  CLAUDE_PROXY_SKIP_OLLAMA_WARMUP=1 \
  node "$PROXY" --config "$CONFIG" --profile 16gb --mode best-cloud >"$PROXY_OUT" 2>"$BASE/proxy.err" &
PROXY_PID=$!

PROXY_PORT=""
for _ in $(seq 1 80); do
  PROXY_PORT="$(sed -n 's/^READY \([0-9][0-9]*\)$/\1/p' "$PROXY_OUT" 2>/dev/null | head -1)"
  [[ -n "$PROXY_PORT" ]] && break
  kill -0 "$PROXY_PID" 2>/dev/null || break
  sleep 0.1
done
assert "[[ -n '$PROXY_PORT' ]]" "proxy READY (got '$PROXY_PORT')"

if [[ -n "$PROXY_PORT" ]]; then
  PING_JSON="$(curl -sf --max-time 2 "http://127.0.0.1:$PROXY_PORT/ping" 2>/dev/null || true)"
  if require_proxy_agent_token_identity "$PROXY_PORT" "$PING_JSON"; then
    pass "same-profile launcher accepts fixed proxy token identity"
  else
    fail "same-profile launcher accepts fixed proxy token identity"
  fi

  served_for() {
    node -e '
    const http=require("http");
    const port=+process.argv[1], content=process.argv[2];
    const body=JSON.stringify({model:"default-model",max_tokens:5,
      messages:[{role:"user",content:content}]});
    const req=http.request({hostname:"127.0.0.1",port,path:"/v1/messages",method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),
        "X-Claude-Code-Agent-Id":"cross-session-agent-test-id"}},
      res=>{res.resume();res.on("end",()=>process.stdout.write(String(res.headers["x-c-thru-served-by"]||"")));});
    req.on("error",()=>process.stdout.write(""));req.write(body);req.end();
  ' "$PROXY_PORT" "$1"
  }
  served_a="$(served_for "$MARKER_A")"
  assert "[[ '$served_a' == 'agent-model' ]]" \
    "session-A signed marker accepted by reused session-B proxy → agent-model (got '$served_a')"
  served_b="$(served_for "$MARKER_B")"
  assert "[[ '$served_b' == 'agent-model' ]]" \
    "session-B signed marker accepted by session-B proxy → agent-model (got '$served_b')"

  st="$(node -e '
    const http=require("http");
    const port=+process.argv[1], tok=process.argv[2];
    const body=JSON.stringify({mode:"best-cloud"});
    const headers={"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),
      "X-C-Thru-Control":tok};
    const req=http.request({hostname:"127.0.0.1",port,path:"/c-thru/mode",method:"POST",headers},
      res=>{res.resume();res.on("end",()=>process.stdout.write(String(res.statusCode)));});
    req.on("error",()=>process.stdout.write("ERR"));req.write(body);req.end();
  ' "$PROXY_PORT" "$TOKEN_A")"
  assert "[[ '$st' == '200' ]]" "session-A control-token still works in session B (got '$st')"

  echo
  echo "C. Different-profile and stale proxy identities fail closed without signaling listener"
  OTHER_PROFILE="$BASE/other-profile"
  export CLAUDE_PROFILE_DIR="$OTHER_PROFILE"
  unset C_THRU_AGENT_SENTINEL_SECRET C_THRU_AGENT_SENTINEL_SECRET_FILE
  ensure_agent_sentinel_secret
  OTHER_AGENT_TOKEN_FILE="$OTHER_PROFILE/proxy.agent-token"
  OTHER_SECRET="$(cat "$OTHER_AGENT_TOKEN_FILE")"
  assert "[[ '$OTHER_SECRET' != '$SECRET_A' ]]" "different CLAUDE_PROFILE_DIR gets a different agent token"

  MISMATCH_ERR="$BASE/mismatch.err"
  MISMATCH_RC=0
  require_proxy_agent_token_identity "$PROXY_PORT" "$PING_JSON" 2>"$MISMATCH_ERR" || MISMATCH_RC=$?
  assert "[[ '$MISMATCH_RC' -ne 0 ]]" "different-profile launcher rejects reused proxy token identity"
  assert "grep -qF 'agent-token fingerprint mismatch' '$MISMATCH_ERR'" "mismatch failure names the agent-token fingerprint"
  assert "kill -0 '$PROXY_PID' 2>/dev/null" "token mismatch does not signal the existing proxy listener"

  STALE_ERR="$BASE/stale.err"
  STALE_RC=0
  require_proxy_agent_token_identity "$PROXY_PORT" '{"ok":true}' 2>"$STALE_ERR" || STALE_RC=$?
  assert "[[ '$STALE_RC' -ne 0 ]]" "pre-upgrade /ping without token identity is rejected"
  assert "grep -qF 'stale or foreign proxy' '$STALE_ERR'" "missing-identity failure identifies stale or foreign proxy"
  assert "kill -0 '$PROXY_PID' 2>/dev/null" "stale-identity rejection leaves existing proxy listener running"
fi

echo
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
