#!/usr/bin/env bash
# R3 residual + quality: fingerprint symmetry + desired derivation parity.
# Run: bash test/c-thru-upstream-fingerprint.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CTHRU="$REPO_DIR/tools/c-thru"
LIB="$REPO_DIR/tools/c-thru-lib.sh"
ENSURE="$REPO_DIR/tools/c-thru-ensure-proxy-on-port.sh"
[[ -f "$CTHRU" && -f "$LIB" && -f "$ENSURE" ]] || {
  echo "fatal: missing tools" >&2
  exit 1
}

# Explicit lib first (do not rely on ensure side-effect).
# shellcheck source=/dev/null
source "$LIB"
# shellcheck source=/dev/null
source "$ENSURE"

# Re-define launcher match helper from tools/c-thru (depends on lib).
eval "$(awk '/^proxy_upstream_fingerprint_matches\(\) \{/,/^\}$/' "$CTHRU")"
type proxy_upstream_fingerprint_matches >/dev/null 2>&1 || {
  echo "fatal: proxy_upstream_fingerprint_matches not sourced" >&2
  exit 1
}
type cthru_desired_anthropic_upstream_fingerprint >/dev/null 2>&1 || {
  echo "fatal: cthru_desired_anthropic_upstream_fingerprint missing from lib" >&2
  exit 1
}

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

fp_of() {
  node -e '
const crypto=require("crypto");
let s=process.argv[1];
try{s=new URL(s).toString()}catch{}
process.stdout.write(crypto.createHash("sha256").update(s).digest("hex").slice(0,16));
' "$1"
}

echo "c-thru upstream fingerprint symmetry (R3 + quality)"
echo ""

echo "1. cthru_upstream_fingerprints_equal (lib)"
cthru_upstream_fingerprints_equal "" "" && pass "∅×∅ match" || fail "∅×∅"
! cthru_upstream_fingerprints_equal "" "deadbeef" && pass "∅×set mismatch" || fail "∅×set"
! cthru_upstream_fingerprints_equal "deadbeef" "" && pass "set×∅ mismatch" || fail "set×∅"
cthru_upstream_fingerprints_equal "deadbeef" "deadbeef" && pass "equal match" || fail "equal"
! cthru_upstream_fingerprints_equal "deadbeef" "cafebabe" && pass "unequal mismatch" || fail "unequal"

echo ""
echo "2. proxy_upstream_fingerprint_matches (launcher keep-alive)"
unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT CLAUDE_PROXY_ANTHROPIC_UPSTREAM
if proxy_upstream_fingerprint_matches '{"ok":true,"anthropic_upstream_fingerprint":""}'; then
  pass "both empty → match"
else
  fail "both empty → match"
fi

export C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT="aaaa1111bbbb2222"
if proxy_upstream_fingerprint_matches '{"ok":true,"anthropic_upstream_fingerprint":""}'; then
  fail "desired set, live empty → mismatch"
else
  pass "desired set, live empty → mismatch"
fi

unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT
if proxy_upstream_fingerprint_matches '{"ok":true,"anthropic_upstream_fingerprint":"aaaa1111bbbb2222"}'; then
  fail "desired empty, live set → mismatch"
else
  pass "desired empty, live set → mismatch"
fi

export C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT="aaaa1111bbbb2222"
if proxy_upstream_fingerprint_matches '{"ok":true,"anthropic_upstream_fingerprint":"aaaa1111bbbb2222"}'; then
  pass "equal hashes → match"
else
  fail "equal hashes → match"
fi

if proxy_upstream_fingerprint_matches '{"ok":true,"anthropic_upstream_fingerprint":"ffff9999eeee8888"}'; then
  fail "unequal hashes → mismatch"
else
  pass "unequal hashes → mismatch"
fi

echo ""
echo "3. Desired from URL only (launcher + ensure parity)"
unset C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT
export CLAUDE_PROXY_ANTHROPIC_UPSTREAM="https://llm-gateway.example.com/anthropic"
expect="$(fp_of "$CLAUDE_PROXY_ANTHROPIC_UPSTREAM")"
got_lib="$(cthru_desired_anthropic_upstream_fingerprint)"
got_ensure="$(cthru_ensure_desired_upstream_fingerprint)"
if [[ "$got_lib" == "$expect" && "$got_ensure" == "$expect" ]]; then
  pass "lib+ensure derive same fingerprint from URL"
else
  fail "derive mismatch lib=$got_lib ensure=$got_ensure expect=$expect"
fi

# Launcher match: FINGERPRINT unset, URL set, live has matching hash
if proxy_upstream_fingerprint_matches "{\"ok\":true,\"anthropic_upstream_fingerprint\":\"$expect\"}"; then
  pass "launcher match derives desired from URL when FINGERPRINT unset"
else
  fail "launcher should match live fp from URL alone"
fi

export C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT="explicitfp0000001"
got2="$(cthru_desired_anthropic_upstream_fingerprint)"
if [[ "$got2" == "explicitfp0000001" ]]; then
  pass "explicit FINGERPRINT env wins over URL"
else
  fail "explicit FINGERPRINT wins (got=$got2)"
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "$PASS/$PASS passed"
  exit 0
fi
echo "$((PASS))/$((PASS + FAIL)) passed — $FAIL FAILED" >&2
exit 1
