#!/usr/bin/env bash
# P2 — cross-session secret stability (HMAC continuity across sessions).
#
# The proxy is a per-user shared daemon: a marker SIGNED by an early session's
# hook must verify in a proxy that a LATER session started. That only holds if
# ensure_per_user_secrets is byte-STABLE across sessions (same CLAUDE_PROFILE_DIR
# → same agent-hmac.key + proxy.control-token), NOT per-session regenerated.
#
# This complements launcher-secret-gen-proxy-enforcement.test.sh (which proves a
# FORGED tag is rejected): here we prove the POSITIVE continuity path —
#   Session A: ensure_per_user_secrets, then sign [[c-thru-agent:<name>:<hmac>]]
#              using the persisted agent-hmac.key (hmac = HMAC-SHA256(key,name)
#              hex, first 16 chars — matching claude-proxy's agentTag()).
#   Session B: ensure_per_user_secrets AGAIN (must be a no-op), then spawn the
#              proxy against the SAME key file. The session-A-signed marker is
#              ACCEPTED (routed to the agent's model), proving the key is shared.
#
# Mirrors the awk-source pattern of launcher-secret-gen-proxy-enforcement.test.sh.
# Run: bash test/cross-session-secret-stability.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTHRU="$REPO_DIR/tools/c-thru"
PROXY="$REPO_DIR/tools/claude-proxy"
[[ -f "$CTHRU" ]] || { echo "fatal: cannot find $CTHRU" >&2; exit 1; }
[[ -f "$PROXY" ]] || { echo "fatal: cannot find $PROXY" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "fatal: node required" >&2; exit 1; }

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

# ── Source the launcher's secret-gen functions in isolation ───────────────────
eval "$(awk '/^gen_secret_hex\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^ensure_per_user_secrets\(\) \{/,/^\}$/' "$CTHRU")"
type ensure_per_user_secrets >/dev/null 2>&1 || { echo "fatal: ensure_per_user_secrets not sourced" >&2; exit 1; }
type gen_secret_hex >/dev/null 2>&1 || { echo "fatal: gen_secret_hex not sourced" >&2; exit 1; }

PROFILE="$BASE/profile"
KEY_FILE="$PROFILE/agent-hmac.key"
TOKEN_FILE="$PROFILE/proxy.control-token"

# ── Session A: generate, capture, sign a marker ───────────────────────────────
echo "A. Session A: ensure_per_user_secrets + sign a sentinel with the persisted key"
CLAUDE_PROFILE_DIR="$PROFILE" ensure_per_user_secrets
assert "[[ -s '$KEY_FILE' ]]" "session A created agent-hmac.key"
assert "[[ -s '$TOKEN_FILE' ]]" "session A created proxy.control-token"
KEY_A="$(cat "$KEY_FILE")"
TOKEN_A="$(cat "$TOKEN_FILE")"

AGENT_NAME="reviewer-plan"
# agentTag() in claude-proxy: HMAC-SHA256(key, name) hex, first 16 chars.
HMAC_TAG="$(node -e '
  const crypto=require("crypto");
  const key=process.argv[1], name=process.argv[2];
  process.stdout.write(crypto.createHmac("sha256",key).update(name).digest("hex").slice(0,16));
' "$KEY_A" "$AGENT_NAME")"
assert "[[ \${#HMAC_TAG} -eq 16 ]]" "computed 16-char HMAC tag for '$AGENT_NAME' (got '$HMAC_TAG')"

# ── Session B: re-run secret-gen, assert STABLE, then start the proxy ──────────
echo
echo "B. Session B: ensure_per_user_secrets again → STABLE (no rotation)"
CLAUDE_PROFILE_DIR="$PROFILE" ensure_per_user_secrets   # second simulated session
KEY_B="$(cat "$KEY_FILE")"
TOKEN_B="$(cat "$TOKEN_FILE")"
assert "[[ '$KEY_A' == '$KEY_B' ]]" "agent-hmac.key STABLE across sessions"
assert "[[ '$TOKEN_A' == '$TOKEN_B' ]]" "proxy.control-token STABLE across sessions"

# Two distinguishable stub backends.
start_stub() {  # $1 = out-port-file
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
assert "[[ -n '$AGENT_PORT' && -n '$DEFAULT_PORT' ]]" "stub backends bound (agent=$AGENT_PORT default=$DEFAULT_PORT)"

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

# Proxy started by "session B" reads session A's persisted key file.
PROXY_OUT="$BASE/proxy.out"
PROXY_HOME="$BASE/proxy-home"; mkdir -p "$PROXY_HOME"
HOME="$PROXY_HOME" \
  CLAUDE_LLM_MODE=best-cloud \
  CLAUDE_PROXY_AGENT_HMAC_FILE="$KEY_FILE" \
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
assert "[[ -n '$PROXY_PORT' ]]" "session B proxy emitted READY <port> (got '$PROXY_PORT')"
[[ -z "$PROXY_PORT" ]] && { echo "proxy stderr:"; sed 's/^/    /' "$BASE/proxy.err"; }

post_messages_header() {  # $1=marker-content $2=header-name
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

echo
echo "C. session-A-signed marker is ACCEPTED by session-B's proxy (HMAC continuity)"
if [[ -n "$PROXY_PORT" ]]; then
  # VALID marker signed with the persisted key → routed to the agent's model.
  VALID="[[c-thru-agent:$AGENT_NAME:$HMAC_TAG]] go"
  served_valid="$(post_messages_header "$VALID" "x-c-thru-served-by")"
  assert "[[ '$served_valid' == 'agent-model' ]]" \
    "session-A marker VERIFIES in session-B proxy → served-by='agent-model' (got '$served_valid')"

  # Counter-case: a tag computed from a DIFFERENT key must be rejected (proves
  # acceptance above is genuine HMAC verification, not fail-open).
  WRONG_TAG="$(node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256","not-the-real-key").update(process.argv[1]).digest("hex").slice(0,16))' "$AGENT_NAME")"
  WRONG="[[c-thru-agent:$AGENT_NAME:$WRONG_TAG]] go"
  served_wrong="$(post_messages_header "$WRONG" "x-c-thru-served-by")"
  assert "[[ '$served_wrong' == 'default-model' ]]" \
    "marker signed with a DIFFERENT key is REJECTED → served-by='default-model' (got '$served_wrong')"
fi

echo
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
