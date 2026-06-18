#!/usr/bin/env bash
# P0 — launcher secret-gen → proxy enforcement (C19 agent-HMAC + C23 control token).
#
# Closes the loop between the two halves of the per-user-secret design:
#   (a) tools/c-thru ensure_per_user_secrets() GENERATES ~/.claude/agent-hmac.key
#       and ~/.claude/proxy.control-token (0600, 64-hex, idempotent) at launch, and
#   (b) tools/claude-proxy READS those same files and ENFORCES with them.
#
# Part A sources ensure_per_user_secrets() (+ its gen_secret_hex dep) verbatim out
# of tools/c-thru — same awk-extraction pattern as c-thru-bootstrap-auth-env.test.sh —
# into a temp CLAUDE_PROFILE_DIR and asserts files/mode/content/idempotency.
#
# Part B spawns claude-proxy pointed at THOSE launcher-generated files (via the
# CLAUDE_PROXY_AGENT_HMAC_FILE / CLAUDE_PROXY_CONTROL_TOKEN_FILE overrides) and
# proves the proxy reads them: a FORGED sentinel is rejected (routes by body.model,
# not the agent) and a mutating control call WITHOUT the token 403s while one WITH
# the launcher-generated token 200s — i.e. the launcher's files ARE the proxy's keys.
#
# JSON/header asserts use node -e (no jq) so run-all registers this unconditionally.
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
  # Disable job-control notifications so killing backgrounded children doesn't
  # spew "Terminated: 15" + the child's command text onto the test output.
  set +m 2>/dev/null
  for pid in "$PROXY_PID" "$STUB_AGENT_PID" "$STUB_DEFAULT_PID"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  rm -rf "$BASE"
}
trap cleanup EXIT

# ── Source the launcher's secret-gen functions in isolation ───────────────────
# Same extraction recipe as c-thru-bootstrap-auth-env.test.sh: pull the exact
# function bodies out of tools/c-thru so we test the SHIPPED generation, not a copy.
eval "$(awk '/^gen_secret_hex\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^ensure_per_user_secrets\(\) \{/,/^\}$/' "$CTHRU")"
type ensure_per_user_secrets >/dev/null 2>&1 || { echo "fatal: ensure_per_user_secrets not sourced" >&2; exit 1; }
type gen_secret_hex >/dev/null 2>&1 || { echo "fatal: gen_secret_hex not sourced" >&2; exit 1; }

file_mode() {  # portable 0600 check: prints octal perms
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
is_64_hex() {  # $1=file → exit 0 if content is exactly 64 hex chars
  local c; c="$(cat "$1" 2>/dev/null)"
  [[ "$c" =~ ^[0-9a-fA-F]{64}$ ]]
}

# ── Part A: generation + mode + content + idempotency ─────────────────────────
echo "A. ensure_per_user_secrets — generation, 0600, 64-hex, idempotent"
PROFILE="$BASE/profile"
export CLAUDE_PROFILE_DIR="$PROFILE"
KEY_FILE="$PROFILE/agent-hmac.key"
TOKEN_FILE="$PROFILE/proxy.control-token"

ensure_per_user_secrets
assert "[[ -f '$KEY_FILE' ]]" "agent-hmac.key created"
assert "[[ -f '$TOKEN_FILE' ]]" "proxy.control-token created"
assert "[[ \"\$(file_mode '$KEY_FILE')\" == '600' ]]" "agent-hmac.key mode 0600 (got $(file_mode "$KEY_FILE"))"
assert "[[ \"\$(file_mode '$TOKEN_FILE')\" == '600' ]]" "proxy.control-token mode 0600 (got $(file_mode "$TOKEN_FILE"))"
assert "is_64_hex '$KEY_FILE'" "agent-hmac.key is 64-hex"
assert "is_64_hex '$TOKEN_FILE'" "proxy.control-token is 64-hex"

KEY_BEFORE="$(cat "$KEY_FILE")"
TOKEN_BEFORE="$(cat "$TOKEN_FILE")"
ensure_per_user_secrets  # second call must be a no-op
assert "[[ \"\$(cat '$KEY_FILE')\" == '$KEY_BEFORE' ]]" "idempotent: agent-hmac.key unchanged on 2nd call"
assert "[[ \"\$(cat '$TOKEN_FILE')\" == '$TOKEN_BEFORE' ]]" "idempotent: proxy.control-token unchanged on 2nd call"
assert "[[ '$KEY_BEFORE' != '$TOKEN_BEFORE' ]]" "the two secrets are distinct values"

# ── Part B: file→proxy loop — the proxy enforces with the launcher's files ─────
echo
echo "B. proxy reads the launcher-generated files and ENFORCES (forged sentinel + control 403)"

# Two distinguishable stub backends (tiny node servers): a successful sentinel
# override hits the agent stub; a rejected one falls back to the default stub.
start_stub() {  # $1 = out-port-file
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

# Wait for both stubs to report their ports.
for pf in "$AGENT_PORT_FILE" "$DEFAULT_PORT_FILE"; do
  for _ in $(seq 1 50); do [[ -s "$pf" ]] && break; sleep 0.1; done
done
AGENT_PORT="$(cat "$AGENT_PORT_FILE" 2>/dev/null)"
DEFAULT_PORT="$(cat "$DEFAULT_PORT_FILE" 2>/dev/null)"
assert "[[ -n '$AGENT_PORT' && -n '$DEFAULT_PORT' ]]" "stub backends bound (agent=$AGENT_PORT default=$DEFAULT_PORT)"

# Fixture: reviewer-plan → plan-reviewer → agent-model (agent stub);
# default-model → default stub. A trusted sentinel rewrites body.model to the
# agent; a rejected one leaves body.model = default-model.
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

# Spawn the proxy pointed at the LAUNCHER-GENERATED secret files (the whole point).
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

# Read "READY <port>" from the proxy's stdout.
PROXY_PORT=""
for _ in $(seq 1 80); do
  PROXY_PORT="$(sed -n 's/^READY \([0-9][0-9]*\)$/\1/p' "$PROXY_OUT" 2>/dev/null | head -1)"
  [[ -n "$PROXY_PORT" ]] && break
  kill -0 "$PROXY_PID" 2>/dev/null || break
  sleep 0.1
done
assert "[[ -n '$PROXY_PORT' ]]" "proxy emitted READY <port> (got '$PROXY_PORT')"
[[ -z "$PROXY_PORT" ]] && { echo "proxy stderr:"; sed 's/^/    /' "$BASE/proxy.err"; echo; }

# Helpers that POST to the proxy and extract a response header / status via node.
# Prints the chosen header value (header mode) or HTTP status (status mode).
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
post_control_status() {  # $1=token-header-value-or-empty → prints HTTP status of POST /c-thru/mode
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
  # C19: a FORGED sentinel (wrong hmac for the name) is rejected — the proxy
  # verified the tag against the launcher's agent-hmac.key and routed by body.model.
  FORGED='[[c-thru-agent:reviewer-plan:0000000000000000]] go'
  served_forged="$(post_messages_header "$FORGED" "x-c-thru-served-by")"
  assert "[[ '$served_forged' == 'default-model' ]]" \
    "forged sentinel REJECTED → served-by='default-model' (key from launcher enforced, got '$served_forged')"

  # Sanity counter-case: a marker that resolves but is unsigned is ALSO rejected
  # because the launcher's key is present (no fail-open).
  UNSIGNED='[[c-thru-agent:reviewer-plan]] go'
  served_unsigned="$(post_messages_header "$UNSIGNED" "x-c-thru-served-by")"
  assert "[[ '$served_unsigned' == 'default-model' ]]" \
    "unsigned sentinel REJECTED (key present, no fail-open) → served-by='default-model' (got '$served_unsigned')"

  # C23: a mutating control call WITHOUT the token 403s; WITH the launcher's
  # token it 200s — proving the proxy read proxy.control-token from the launcher.
  st_notok="$(post_control_status "")"
  assert "[[ '$st_notok' == '403' ]]" "control /c-thru/mode WITHOUT token → 403 (got '$st_notok')"
  st_tok="$(post_control_status "$TOKEN_BEFORE")"
  assert "[[ '$st_tok' == '200' ]]" "control /c-thru/mode WITH launcher token → 200 (got '$st_tok')"
  st_badtok="$(post_control_status "$(printf 'b%.0s' {1..64})")"
  assert "[[ '$st_badtok' == '403' ]]" "control /c-thru/mode with WRONG token → 403 (got '$st_badtok')"
fi

echo
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
