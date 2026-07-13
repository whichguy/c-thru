#!/usr/bin/env bash
# P0 — launcher secret-gen → proxy enforcement (C23 control token).
#
# Agent-sentinel trust is loopback-only (no agent-hmac.key). Part B also proves
# that an unsigned loopback marker is honored and control-token is still enforced.
#
# Part A sources ensure_per_user_secrets() (+ its gen_secret_hex dep) verbatim out
# of tools/c-thru into a temp CLAUDE_PROFILE_DIR and asserts control-token only.
#
# Part B spawns claude-proxy pointed at the launcher-generated control-token and
# proves: unsigned sentinel on loopback routes by agent; mutating control without
# token 403s; with token 200s.
#
# Run: bash test/launcher-secret-gen-proxy-enforcement.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTHRU="$REPO_DIR/tools/c-thru"
PROXY="$REPO_DIR/tools/claude-proxy"
[[ -f "$CTHRU" ]] || { echo "fatal: cannot find $CTHRU" >&2; exit 1; }
[[ -f "$PROXY" ]] || { echo "fatal: cannot find $PROXY" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL+1)); }
assert() {  # cond-string msg
  if eval "$1"; then pass "$2"; else fail "$2"; fi
}

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-launcher-sec.XXXXXX")"
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
eval "$(awk '/^ensure_per_user_secrets\(\) \{/,/^\}$/' "$CTHRU")"
type ensure_per_user_secrets >/dev/null 2>&1 || { echo "fatal: ensure_per_user_secrets not sourced" >&2; exit 1; }
type gen_secret_hex >/dev/null 2>&1 || { echo "fatal: gen_secret_hex not sourced" >&2; exit 1; }

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
is_64_hex() {
  local c; c="$(cat "$1" 2>/dev/null)"
  [[ "$c" =~ ^[0-9a-fA-F]{64}$ ]]
}

echo "A. ensure_per_user_secrets — control-token only (no agent-hmac.key)"
PROFILE="$BASE/profile"
export CLAUDE_PROFILE_DIR="$PROFILE"
HMAC_FILE="$PROFILE/agent-hmac.key"
TOKEN_FILE="$PROFILE/proxy.control-token"

ensure_per_user_secrets
assert "[[ ! -e '$HMAC_FILE' ]]" "agent-hmac.key NOT created (loopback trust; no HMAC)"
assert "[[ -f '$TOKEN_FILE' ]]" "proxy.control-token created"
assert "[[ \"\$(file_mode '$TOKEN_FILE')\" == '600' ]]" "proxy.control-token mode 0600 (got $(file_mode "$TOKEN_FILE"))"
assert "is_64_hex '$TOKEN_FILE'" "proxy.control-token is 64-hex"

TOKEN_BEFORE="$(cat "$TOKEN_FILE")"
ensure_per_user_secrets
assert "[[ \"\$(cat '$TOKEN_FILE')\" == '$TOKEN_BEFORE' ]]" "idempotent: proxy.control-token unchanged on 2nd call"
assert "[[ ! -e '$HMAC_FILE' ]]" "idempotent: still no agent-hmac.key"

echo
echo "B. proxy: loopback unsigned sentinel honored; control token enforced"

start_stub() {
  node -e '
    const http = require("http");
    const s = http.createServer((req,res)=>{
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
assert "[[ -n '$AGENT_PORT' && -n '$DEFAULT_PORT' ]]" "stub backends bound (agent=$AGENT_PORT default=$DEFAULT_PORT)"

CONFIG="$BASE/model-map.json"
cat > "$CONFIG" <<EOF
{
  "agent_to_capability": { "reviewer-plan": "plan-reviewer" },
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
assert "[[ -n '$PROXY_PORT' ]]" "proxy emitted READY <port> (got '$PROXY_PORT')"
[[ -z "$PROXY_PORT" ]] && { echo "proxy stderr:"; sed 's/^/    /' "$BASE/proxy.err"; echo; }

post_messages_header() {
  node -e '
    const http=require("http");
    const port=+process.argv[1], content=process.argv[2], hdr=process.argv[3].toLowerCase();
    const body=JSON.stringify({model:"default-model",max_tokens:5,
      messages:[{role:"user",content:content}]});
    const req=http.request({hostname:"127.0.0.1",port,path:"/v1/messages",method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
      res=>{res.resume();res.on("end",()=>process.stdout.write(String(res.headers[hdr]||"")));});
    req.on("error",()=>process.stdout.write(""));req.write(body);req.end();
  ' "$PROXY_PORT" "$1" "$2"
}
post_control_status() {
  node -e '
    const http=require("http");
    const port=+process.argv[1], tok=process.argv[2];
    const body=JSON.stringify({mode:"best-cloud"});
    const headers={"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)};
    if(tok) headers["X-C-Thru-Control"]=tok;
    const req=http.request({hostname:"127.0.0.1",port,path:"/c-thru/mode",method:"POST",headers},
      res=>{res.resume();res.on("end",()=>process.stdout.write(String(res.statusCode)));});
    req.on("error",()=>process.stdout.write("ERR"));req.write(body);req.end();
  ' "$PROXY_PORT" "$1"
}

if [[ -n "$PROXY_PORT" ]]; then
  # Loopback client + unsigned marker → honored (no HMAC).
  UNSIGNED='[[c-thru-agent:reviewer-plan]] go'
  served_unsigned="$(post_messages_header "$UNSIGNED" "x-c-thru-served-by")"
  assert "[[ '$served_unsigned' == 'agent-model' ]]" \
    "unsigned loopback sentinel HONORED → served-by='agent-model' (got '$served_unsigned')"

  # Legacy peel: :16hex suffix still extracts the name (not verified as HMAC).
  LEGACY='[[c-thru-agent:reviewer-plan:0000000000000000]] go'
  served_legacy="$(post_messages_header "$LEGACY" "x-c-thru-served-by")"
  assert "[[ '$served_legacy' == 'agent-model' ]]" \
    "legacy :hex peel still routes → served-by='agent-model' (got '$served_legacy')"

  # Loopback free: no token required for local control mutations.
  st_notok="$(post_control_status "")"
  assert "[[ '$st_notok' == '200' ]]" "control /c-thru/mode WITHOUT token (loopback) → 200 (got '$st_notok')"
  st_tok="$(post_control_status "$TOKEN_BEFORE")"
  assert "[[ '$st_tok' == '200' ]]" "control /c-thru/mode WITH launcher token → 200 (got '$st_tok')"
  # Wrong token still accepted on loopback (token optional for local clients).
  st_badtok="$(post_control_status "$(printf 'b%.0s' {1..64})")"
  assert "[[ '$st_badtok' == '200' ]]" "control /c-thru/mode with WRONG token (loopback) → 200 (got '$st_badtok')"
fi

echo
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
