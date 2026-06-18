#!/usr/bin/env bash
# P2 — explicit-port cross-session proxy reuse (flock-vs-mkdir-lockdir path).
#
# Two c-thru-style proxy-spawn attempts on the SAME explicit CLAUDE_PROXY_PORT
# must NOT each spawn a proxy: the second attempt has to ATTACH to the first's
# proxy (the /ping config-match reuse branch in ensure_proxy_running) instead of
# launching a duplicate or erroring.
#
# Hermetic strategy: rather than drive the full c-thru launch (which execs the
# real `claude` binary), we source the SHIPPED ensure_proxy_running + its proxy
# helper-fn dependencies out of tools/c-thru (same awk-extraction recipe as
# c-thru-bootstrap-auth-env.test.sh / launcher-secret-gen-proxy-enforcement.sh)
# plus tools/c-thru-lib.sh for proxy_port_from_base_url. We:
#   Session A: ensure_proxy_running with CLAUDE_PROXY_PORT=P → spawns one proxy.
#   Session B: ensure_proxy_running with the SAME port + SAME CONFIG → must
#              REUSE (return 0, spawn nothing). We assert the live /ping pid is
#              unchanged and that Session B set no PROXY_STARTED_PID.
#
# Run: bash test/proxy-reuse-lock.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTHRU="$REPO_DIR/tools/c-thru"
LIB="$REPO_DIR/tools/c-thru-lib.sh"
PROXY="$REPO_DIR/tools/claude-proxy"
for f in "$CTHRU" "$LIB" "$PROXY"; do
  [[ -f "$f" ]] || { echo "fatal: cannot find $f" >&2; exit 1; }
done

command -v node >/dev/null 2>&1 || { echo "fatal: node required" >&2; exit 1; }
command -v lsof >/dev/null 2>&1 || { echo "SKIP: lsof unavailable (proxy_listener_pid needs it)"; echo "0 tests: 0 passed, 0 failed"; exit 0; }

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL+1)); }
assert() { if eval "$1"; then pass "$2"; else fail "$2"; fi; }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-reuse-lock.XXXXXX")"
PROXY_A_PID=""
cleanup() {
  set +m 2>/dev/null
  [[ -n "$PROXY_A_PID" ]] && kill "$PROXY_A_PID" 2>/dev/null && wait "$PROXY_A_PID" 2>/dev/null
  rm -rf "$BASE"
}
trap cleanup EXIT

# ── Source the shipped lib + the launcher's proxy helpers in isolation ────────
# c-thru-lib.sh provides proxy_port_from_base_url + claude_proxy_listen_port.
# shellcheck disable=SC1090
source "$LIB"

# Pull the exact ensure_proxy_running body + every proxy helper it calls out of
# tools/c-thru. awk range-extraction matches each `name() {` ... matching `}`.
extract_fn() { awk "/^$1\\(\\) \\{/,/^\\}\$/" "$CTHRU"; }
for fn in \
  proxy_port_is_explicit claude_proxy_http_base wait_proxy_ping_ready proxy_ping_json \
  verify_proxy_health diagnose_proxy_startup_failure wait_proxy_listener_gone \
  proxy_listener_pid pid_looks_like_proxy is_local_http_base_url proxy_logging_enabled \
  ensure_proxy_log_parent_dir proxy_log_final_path proxy_log_startup_path \
  proxy_ephemeral_stderr_path describe_proxy_log_target ensure_per_user_secrets \
  gen_secret_hex ensure_proxy_running; do
  src="$(extract_fn "$fn")"
  if [[ -z "$src" ]]; then
    echo "  (note: helper '$fn' not found via awk extraction — defining stub)" >&2
    continue
  fi
  eval "$src"
done
# The real arm_proxy_cleanup installs EXIT/INT/TERM traps that reference launcher
# globals we don't have here (cleanup_ephemeral_session / proxy_signal_handler)
# and would clobber THIS test's cleanup trap. Stub it + cleanup_proxy_children to
# no-ops; we own teardown via our own EXIT trap. These fire only on the spawn
# path, not the reuse path — stubbing them doesn't weaken the reuse assertions.
arm_proxy_cleanup() { :; }
cleanup_proxy_children() { :; }
PROXY_CLEANUP_ARMED=0
_PROXY_SPIN_PID=""
type proxy_log_startup_path    >/dev/null 2>&1 || proxy_log_startup_path() { printf ''; }
type describe_proxy_log_target >/dev/null 2>&1 || describe_proxy_log_target() { printf ''; }

type ensure_proxy_running >/dev/null 2>&1 || { echo "fatal: ensure_proxy_running not sourced" >&2; exit 1; }

# ── Environment ensure_proxy_running reads ────────────────────────────────────
CTHRU_REPO_ROOT="$REPO_DIR"          # so it finds $CTHRU_REPO_ROOT/tools/claude-proxy
CLAUDE_PROFILE_DIR="$BASE/profile"   # secrets + lockfiles land here
mkdir -p "$CLAUDE_PROFILE_DIR"
GRAY=""; BOLD=""; NC=""              # color vars used in status prints
OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"

# Config the proxy will report on /ping; CONFIG must equal the proxy's realpath'd
# CLAUDE_MODEL_MAP_PATH for the reuse config-match to fire.
RAW_CONFIG="$BASE/model-map.json"
cat > "$RAW_CONFIG" <<'EOF'
{ "model_routes": { "m": "be" },
  "endpoints": { "be": { "kind": "anthropic", "url": "http://127.0.0.1:1" } } }
EOF
CONFIG="$(node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$RAW_CONFIG")"
export CLAUDE_MODEL_MAP_PATH="$CONFIG"   # ensure_proxy_running spawns proxy with CLAUDE_MODEL_MAP_PATH="$CONFIG"

# Pick a free explicit port (and immediately release it).
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
export CLAUDE_PROXY_PORT="$PORT"
BASE_URL="http://127.0.0.1:$PORT"

export CLAUDE_PROXY_STARTUP_PROBE=0
export CLAUDE_PROXY_SKIP_OLLAMA_WARMUP=1
export HOME="$BASE/home"; mkdir -p "$HOME"

echo "1. Session A: ensure_proxy_running spawns the proxy on explicit :$PORT"
PROXY_STARTED_PID=""
PROXY_PORT=""
ensure_proxy_running "$BASE_URL"
ec_a=$?
assert "[[ $ec_a -eq 0 ]]" "Session A ensure_proxy_running returns 0 (got $ec_a)"
assert "[[ -n '$PROXY_STARTED_PID' ]]" "Session A spawned a proxy (PROXY_STARTED_PID set: '$PROXY_STARTED_PID')"
PROXY_A_PID="$PROXY_STARTED_PID"

# Live pid as reported by the proxy itself.
PING_A="$(curl -sf --max-time 2 "$BASE_URL/ping" 2>/dev/null || true)"
PID_A="$(printf '%s' "$PING_A" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).pid||""))}catch{process.stdout.write("")}})')"
CFG_A="$(printf '%s' "$PING_A" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).config_path||""))}catch{process.stdout.write("")}})')"
assert "[[ -n '$PID_A' ]]" "proxy answered /ping with a pid (got '$PID_A')"
assert "[[ '$CFG_A' == '$CONFIG' ]]" "proxy /ping config_path matches CONFIG (got '$CFG_A')"

echo
echo "2. Session B: SAME explicit port + SAME config → REUSE, no duplicate spawn"
# Fresh per-session state (a new shell would start with these unset).
PROXY_STARTED_PID=""
PROXY_PORT=""
ensure_proxy_running "$BASE_URL"
ec_b=$?
assert "[[ $ec_b -eq 0 ]]" "Session B ensure_proxy_running returns 0 — attached, did not error (got $ec_b)"
assert "[[ -z '$PROXY_STARTED_PID' ]]" "Session B spawned NOTHING (PROXY_STARTED_PID empty: '$PROXY_STARTED_PID')"

# The proxy on :$PORT must be the SAME process A started (no duplicate listener,
# no restart). Same pid via /ping proves reuse.
PING_B="$(curl -sf --max-time 2 "$BASE_URL/ping" 2>/dev/null || true)"
PID_B="$(printf '%s' "$PING_B" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).pid||""))}catch{process.stdout.write("")}})')"
assert "[[ -n '$PID_B' && '$PID_B' == '$PID_A' ]]" "reused the same proxy pid across sessions (A=$PID_A B=$PID_B)"

# Exactly one listener on the port (no duplicate proxy bound to it).
LISTENERS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u | wc -l | tr -d ' ')"
assert "[[ '$LISTENERS' == '1' ]]" "exactly one process listening on :$PORT (got $LISTENERS)"

echo
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
