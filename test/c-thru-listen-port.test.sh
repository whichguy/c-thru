#!/usr/bin/env bash
# Unit test for claude_proxy_listen_port() ANTHROPIC_BASE_URL discovery (Part 3.1).
#
# In plugin mode the process has no CLAUDE_PROXY_PORT/PROXY_PORT and no proxy.pid,
# but settings.json pre-wrote ANTHROPIC_BASE_URL at the proxy's fixed port. The
# new branch derives the port from that URL (reusing proxy_port_from_base_url),
# BEFORE the pid-file/lsof fallback, so `c-thru --list` / the c-thru-status skill
# find the proxy in plugin mode — not just CLI mode.
#
# claude_proxy_listen_port() + proxy_port_from_base_url() now live in
# c-thru-lib.sh (moved out of tools/c-thru) — source it directly. The previous
# `awk`-extraction of these defs from tools/c-thru broke the instant they moved;
# the dedicated c-thru-lib.test.sh covers the lib in full, while this suite stays
# the ANTHROPIC_BASE_URL discovery regression net.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../tools/c-thru-lib.sh"
[[ -f "$LIB" ]] || { echo "fatal: cannot find $LIB" >&2; exit 1; }
# shellcheck source=/dev/null
source "$LIB"

PASS=0
FAIL=0
assert_eq() {  # label expected actual
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1 (expected '$2', got '$3')" >&2; FAIL=$((FAIL+1)); fi
}

# A profile dir with NO proxy.pid → the pid-file fallback yields empty, so any
# resolved port provably comes from the ANTHROPIC_BASE_URL branch.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-listen-port.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Run listen_port with a fully-controlled env (subshell inherits the functions).
listen_port() {  # arg pairs as NAME=VALUE strings; others are unset
  (
    unset CLAUDE_PROXY_PORT PROXY_PORT CLAUDE_PROXY_USE_OLLAMA_PORT \
          ANTHROPIC_BASE_URL C_THRU_PLUGIN_PORT
    export CLAUDE_PROFILE_DIR="$TMP"
    for kv in "$@"; do export "$kv"; done
    claude_proxy_listen_port
  )
}

echo "1. ANTHROPIC_BASE_URL with explicit loopback port → that port (no PROXY_PORT/pid)"
assert_eq "http://127.0.0.1:54321 → 54321" "54321" \
  "$(listen_port "ANTHROPIC_BASE_URL=http://127.0.0.1:54321")"

echo "2. ANTHROPIC_BASE_URL loopback, no port → plugin default 10017"
assert_eq "http://127.0.0.1 → 10017" "10017" \
  "$(listen_port "ANTHROPIC_BASE_URL=http://127.0.0.1")"

echo "3. ANTHROPIC_BASE_URL loopback, no port + C_THRU_PLUGIN_PORT override → override"
assert_eq "http://127.0.0.1 + C_THRU_PLUGIN_PORT=12000 → 12000" "12000" \
  "$(listen_port "ANTHROPIC_BASE_URL=http://127.0.0.1" "C_THRU_PLUGIN_PORT=12000")"

echo "4. explicit port wins for any host (localhost:8080 → 8080)"
assert_eq "http://localhost:8080 → 8080" "8080" \
  "$(listen_port "ANTHROPIC_BASE_URL=http://localhost:8080")"

echo "5. CLAUDE_PROXY_PORT takes precedence over ANTHROPIC_BASE_URL"
assert_eq "CLAUDE_PROXY_PORT=9999 + base url :54321 → 9999" "9999" \
  "$(listen_port "CLAUDE_PROXY_PORT=9999" "ANTHROPIC_BASE_URL=http://127.0.0.1:54321")"

echo "6. non-loopback, portless base URL does NOT hijack — falls through to pid-file (empty here)"
assert_eq "http://example.com → '' (no pid file)" "" \
  "$(listen_port "ANTHROPIC_BASE_URL=http://example.com")"

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
