#!/usr/bin/env bash
# Ambient trust gate, fingerprint matrix + ensure no-kill, unit pins for upstream fixes.
# Run: bash test/c-thru-anthropic-upstream-fixes.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C_THRU="$REPO_DIR/tools/c-thru"
LIB="$REPO_DIR/tools/c-thru-lib.sh"
ENSURE="$REPO_DIR/tools/c-thru-ensure-proxy-on-port.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

[[ -f "$LIB" && -f "$C_THRU" && -f "$ENSURE" ]] || {
  echo "fatal: missing tools" >&2
  exit 1
}

# shellcheck source=/dev/null
source "$LIB"

echo "c-thru-anthropic-upstream-fixes tests"
echo

# ── T4: four-cell fingerprint matrix (lib) ───────────────────────────────────
echo "1. T4 fingerprint matrix (cthru_upstream_fingerprints_equal)"
cthru_upstream_fingerprints_equal "" "" && pass "∅×∅ match" || fail "∅×∅"
! cthru_upstream_fingerprints_equal "" "deadbeef" && pass "∅×set mismatch" || fail "∅×set"
! cthru_upstream_fingerprints_equal "deadbeef" "" && pass "set×∅ mismatch" || fail "set×∅"
cthru_upstream_fingerprints_equal "deadbeef" "deadbeef" && pass "equal match" || fail "equal"
! cthru_upstream_fingerprints_equal "deadbeef" "cafebabe" && pass "unequal mismatch" || fail "unequal"

# ── Extract resolve helpers from tools/c-thru (not full-sourceable) ──────────
# Brace-counting fails on embedded node -e strings; use line markers.
TMP_EXTRACT="$(mktemp "${TMPDIR:-/tmp}/c-thru-up-extract.XXXXXX")"
START_LINE="$(rg -n '^_cthru_upstream_url_js\(\)' "$C_THRU" | head -1 | cut -d: -f1)"
END_LINE="$(rg -n '^anthropic_upstream_override_active\(\)' "$C_THRU" | head -1 | cut -d: -f1)"
if [[ -n "$START_LINE" && -n "$END_LINE" && "$END_LINE" -gt "$START_LINE" ]]; then
  # The extracted helper normally inherits this from the launched c-thru script.
  export CTHRU_SELF_DIR="$(dirname "$C_THRU")"
  sed -n "${START_LINE},$((END_LINE - 1))p" "$C_THRU" > "$TMP_EXTRACT"
  # shellcheck source=/dev/null
  source "$TMP_EXTRACT" || {
    echo "  WARN  extract source failed" >&2
  }
else
  echo "  WARN  could not locate resolve functions in tools/c-thru" >&2
fi

echo
echo "2. T1/T2 ambient trust gate (resolve_and_export_anthropic_upstream)"
if type resolve_and_export_anthropic_upstream >/dev/null 2>&1; then
  # Inline (not subshell) so pass/fail counters stick.
  unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_ANTHROPIC_UPSTREAM C_THRU_CLI_ANTHROPIC_UPSTREAM
  unset C_THRU_TRUST_AMBIENT_UPSTREAM C_THRU_IGNORE_AMBIENT_ANTHROPIC_BASE_URL
  unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT C_THRU_ANTHROPIC_UPSTREAM_SOURCE
  unset C_THRU_AMBIENT_UPSTREAM_NOTED C_THRU_LOOSE_UPSTREAM_WARNED
  export C_THRU_CALLER_ANTHROPIC_BASE_URL="https://gw.example.com/anthropic"
  resolve_and_export_anthropic_upstream || true
  if [[ -z "${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}" ]]; then
    pass "T1 ambient without trust → upstream unset"
  else
    fail "T1 expected unset got ${CLAUDE_PROXY_ANTHROPIC_UPSTREAM}"
  fi

  unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_ANTHROPIC_UPSTREAM C_THRU_CLI_ANTHROPIC_UPSTREAM
  unset C_THRU_IGNORE_AMBIENT_ANTHROPIC_BASE_URL
  unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT C_THRU_ANTHROPIC_UPSTREAM_SOURCE
  unset C_THRU_AMBIENT_UPSTREAM_NOTED C_THRU_LOOSE_UPSTREAM_WARNED
  export C_THRU_CALLER_ANTHROPIC_BASE_URL="https://gw.example.com/anthropic"
  export C_THRU_TRUST_AMBIENT_UPSTREAM=1
  resolve_and_export_anthropic_upstream || true
  case "${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}" in
    https://gw.example.com/anthropic|https://gw.example.com/anthropic/)
      pass "T2 ambient + trust → upstream set"
      ;;
    *)
      fail "T2 expected gateway got '${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}'"
      ;;
  esac

  unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_ANTHROPIC_UPSTREAM C_THRU_CLI_ANTHROPIC_UPSTREAM
  unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT C_THRU_ANTHROPIC_UPSTREAM_SOURCE
  unset C_THRU_AMBIENT_UPSTREAM_NOTED C_THRU_LOOSE_UPSTREAM_WARNED
  export C_THRU_CALLER_ANTHROPIC_BASE_URL="https://gw.example.com/anthropic"
  export C_THRU_TRUST_AMBIENT_UPSTREAM=1
  export C_THRU_IGNORE_AMBIENT_ANTHROPIC_BASE_URL=1
  resolve_and_export_anthropic_upstream || true
  if [[ -z "${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}" ]]; then
    pass "IGNORE ambient overrides trust"
  else
    fail "IGNORE should clear upstream"
  fi

  unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_CLI_ANTHROPIC_UPSTREAM
  unset C_THRU_CALLER_ANTHROPIC_BASE_URL C_THRU_TRUST_AMBIENT_UPSTREAM C_THRU_IGNORE_AMBIENT_ANTHROPIC_BASE_URL
  unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT C_THRU_ANTHROPIC_UPSTREAM_SOURCE
  unset C_THRU_AMBIENT_UPSTREAM_NOTED C_THRU_LOOSE_UPSTREAM_WARNED
  export C_THRU_ANTHROPIC_UPSTREAM="https://explicit.example.com/v1"
  resolve_and_export_anthropic_upstream || true
  case "${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}" in
    https://explicit.example.com/v1|https://explicit.example.com/v1/)
      pass "T3 explicit env needs no trust"
      ;;
    *)
      fail "T3 explicit got '${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}'"
      ;;
  esac
else
  fail "resolve_and_export_anthropic_upstream not extracted"
fi

# ── T5: ensure-on-port does not kill when desired empty + live set ───────────
echo
echo "3. T5 ensure no-kill when desired empty + live override fingerprint"
# shellcheck source=/dev/null
source "$ENSURE"
unset ANTHROPIC_BASE_URL
unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT

if ! command -v node >/dev/null 2>&1; then
  echo "  SKIP  node missing for T5"
else
  STUBDIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-up-stub.XXXXXX")"
  INFO="$STUBDIR/port"
  PIDF="$STUBDIR/pid"
  cat > "$STUBDIR/stub.js" <<'JS'
const http = require('http');
const fs = require('fs');
const out = process.argv[2];
const pidf = process.argv[3];
const fp = 'aabbccddeeff0011';
const s = http.createServer((q, r) => {
  if (String(q.url || '').indexOf('ping') >= 0) {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      anthropic_upstream_override: true,
      anthropic_upstream_fingerprint: fp,
    }));
    return;
  }
  r.writeHead(404);
  r.end();
});
s.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(out, String(s.address().port));
  fs.writeFileSync(pidf, String(process.pid));
});
setTimeout(() => process.exit(0), 20000);
JS
  node "$STUBDIR/stub.js" "$INFO" "$PIDF" 2>"$STUBDIR/stub.err" &
  STUB_PID=$!
  for _ in $(seq 1 50); do [[ -s "$INFO" ]] && break; sleep 0.05; done
  PORT="$(cat "$INFO" 2>/dev/null || true)"
  LIVE_PID="$(cat "$PIDF" 2>/dev/null || true)"
  if [[ -z "$PORT" || -z "$LIVE_PID" ]]; then
    if grep -q 'listen EPERM' "$STUBDIR/stub.err" 2>/dev/null; then
      echo "  SKIP  T5 sandbox denied loopback bind; needs native verification"
    else
      fail "T5 stub failed to start"
    fi
  else
    # desired empty, live has fingerprint → should return 1 without killing
    unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"
    cthru_ensure_proxy_on_port "$PORT"
    ec=$?
    if [[ $ec -ne 0 ]]; then
      pass "T5 ensure refuses (ec=$ec)"
    else
      fail "T5 ensure should refuse reuse (ec=0)"
    fi
    if kill -0 "$LIVE_PID" 2>/dev/null; then
      pass "T5 co-tenant proxy still alive (no kill)"
    else
      fail "T5 proxy was killed"
    fi
  fi
  kill "$STUB_PID" 2>/dev/null || true
  wait "$STUB_PID" 2>/dev/null || true
  rm -rf "$STUBDIR"
fi

rm -f "$TMP_EXTRACT"

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
exit $?
