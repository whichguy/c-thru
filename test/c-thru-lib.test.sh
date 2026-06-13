#!/usr/bin/env bash
# Unit test for tools/c-thru-lib.sh — the sourceable env/discovery resolvers.
#
# Covers: port-ladder precedence, the shadow-vs-durable profile-dir split
# (and its shadow-isolation guarantee), cthru_ollama_url precedence, and the
# key structural claim of the refactor — the hook ladder DROPS the pid-file/lsof
# tail while the full claude_proxy_listen_port ladder KEEPS it.
#
# Runs under `set -u` so an unguarded ${VAR} in the lib would surface as an
# error here (the lib's set-u-safety contract).

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

# Run a lib function in a clean subshell with ONLY the given NAME=VALUE env set.
run() {  # FUNC [NAME=VALUE...]
  local fn="$1"; shift
  (
    unset CLAUDE_PROXY_PORT PROXY_PORT CLAUDE_PROXY_USE_OLLAMA_PORT ANTHROPIC_BASE_URL \
          C_THRU_PLUGIN_PORT CLAUDE_PROFILE_DIR CLAUDE_CONFIG_DIR CLAUDE_DIR \
          OLLAMA_URL OLLAMA_BASE_URL
    for kv in "$@"; do export "$kv"; done
    "$fn"
  )
}

echo "1. proxy_port_from_base_url"
assert_eq "explicit loopback port"        "54321" "$(proxy_port_from_base_url 'http://127.0.0.1:54321')"
assert_eq "loopback, no port → empty"     ""      "$(proxy_port_from_base_url 'http://127.0.0.1')"
assert_eq "localhost explicit port"       "8080"  "$(proxy_port_from_base_url 'http://localhost:8080')"
assert_eq "remote, no port → empty"       ""      "$(proxy_port_from_base_url 'http://example.com')"

echo "2. cthru_hook_listen_port precedence (hot-path ladder, NO pid tail)"
assert_eq "CLAUDE_PROXY_PORT wins"        "9999"  "$(run cthru_hook_listen_port CLAUDE_PROXY_PORT=9999 PROXY_PORT=1 ANTHROPIC_BASE_URL=http://127.0.0.1:2)"
assert_eq "PROXY_PORT next"               "8888"  "$(run cthru_hook_listen_port PROXY_PORT=8888 ANTHROPIC_BASE_URL=http://127.0.0.1:2)"
assert_eq "USE_OLLAMA_PORT → 11434"       "11434" "$(run cthru_hook_listen_port CLAUDE_PROXY_USE_OLLAMA_PORT=1)"
assert_eq "ANTHROPIC_BASE_URL explicit"   "54321" "$(run cthru_hook_listen_port ANTHROPIC_BASE_URL=http://127.0.0.1:54321)"
assert_eq "loopback no port → plugin dflt" "10017" "$(run cthru_hook_listen_port ANTHROPIC_BASE_URL=http://127.0.0.1)"
assert_eq "loopback no port + override"   "12000" "$(run cthru_hook_listen_port ANTHROPIC_BASE_URL=http://127.0.0.1 C_THRU_PLUGIN_PORT=12000)"
assert_eq "remote portless → empty"       ""      "$(run cthru_hook_listen_port ANTHROPIC_BASE_URL=http://example.com)"
assert_eq "nothing set → empty"           ""      "$(run cthru_hook_listen_port)"

echo "3. pid-file/lsof tail: dropped from the hook ladder, kept in the full ladder"
PIDDIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-lib-pid.XXXXXX")"
BINDIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-lib-bin.XXXXXX")"
trap 'rm -rf "$PIDDIR" "$BINDIR"' EXIT
echo "$$" > "$PIDDIR/proxy.pid"   # a LIVE pid (this test process)
# A fake lsof emitting one LISTEN line whose col-9 host:port ends in 4242.
cat > "$BINDIR/lsof" <<'LSOF'
#!/usr/bin/env bash
echo "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME"
echo "node 1234 user 23u IPv4 0xabc 0t0 TCP 127.0.0.1:4242 (LISTEN)"
LSOF
chmod +x "$BINDIR/lsof"

# Hook ladder: a proxy.pid is present but there is NO env signal → empty, because
# the hook ladder has no pid logic at all (proves the tail was dropped).
assert_eq "hook ladder ignores proxy.pid" "" \
  "$(run cthru_hook_listen_port CLAUDE_PROFILE_DIR="$PIDDIR")"

# Full ladder: same setup but with the fake lsof on PATH → it resolves the port
# from the pid file (proves the tail is present here, in the one canonical source).
full_pid_port="$(
  unset CLAUDE_PROXY_PORT PROXY_PORT CLAUDE_PROXY_USE_OLLAMA_PORT ANTHROPIC_BASE_URL C_THRU_PLUGIN_PORT
  export CLAUDE_PROFILE_DIR="$PIDDIR"
  export PATH="$BINDIR:$PATH"
  claude_proxy_listen_port
)"
assert_eq "full ladder consults pid-file via lsof" "4242" "$full_pid_port"

# Full ladder still honors the leading env ladder (delegates to the hook ladder).
assert_eq "full ladder env signal wins over pid" "9999" \
  "$(run claude_proxy_listen_port CLAUDE_PROXY_PORT=9999 CLAUDE_PROFILE_DIR="$PIDDIR")"

echo "4. cthru_effective_profile_dir (the session SHADOW)"
assert_eq "CLAUDE_PROFILE_DIR wins"  "/p"            "$(run cthru_effective_profile_dir CLAUDE_PROFILE_DIR=/p CLAUDE_CONFIG_DIR=/c CLAUDE_DIR=/d)"
assert_eq "CLAUDE_CONFIG_DIR next"   "/c"            "$(run cthru_effective_profile_dir CLAUDE_CONFIG_DIR=/c CLAUDE_DIR=/d)"
assert_eq "default \$HOME/.claude"   "$HOME/.claude" "$(run cthru_effective_profile_dir)"

echo "5. cthru_original_profile_dir (the DURABLE original) + shadow-isolation"
assert_eq "CLAUDE_DIR wins"          "/d"            "$(run cthru_original_profile_dir CLAUDE_DIR=/d CLAUDE_CONFIG_DIR=/c CLAUDE_PROFILE_DIR=/p)"
assert_eq "CLAUDE_CONFIG_DIR next"   "/c"            "$(run cthru_original_profile_dir CLAUDE_CONFIG_DIR=/c)"
# THE shadow-isolation guarantee: a session shadow must NOT leak into the durable
# resolver. With only CLAUDE_PROFILE_DIR set, original is $HOME/.claude, not /shadow.
assert_eq "ignores CLAUDE_PROFILE_DIR" "$HOME/.claude" "$(run cthru_original_profile_dir CLAUDE_PROFILE_DIR=/shadow)"

echo "6. cthru_ollama_url precedence"
assert_eq "OLLAMA_URL wins"          "http://u" "$(run cthru_ollama_url OLLAMA_URL=http://u OLLAMA_BASE_URL=http://b)"
assert_eq "OLLAMA_BASE_URL next"     "http://b" "$(run cthru_ollama_url OLLAMA_BASE_URL=http://b)"
assert_eq "default localhost:11434"  "http://localhost:11434" "$(run cthru_ollama_url)"

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
