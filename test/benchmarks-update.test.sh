#!/usr/bin/env bash
# Test for tools/c-thru-benchmarks-update.sh — the durable-stamp / shadow-pid
# resolver split (commit 03c127f). Mirrors the co-located-lib scratch pattern in
# test/session-start-seeding.test.sh: copy the script + c-thru-lib.sh into a
# scratch tools/ (its real deployment shape), stub curl, and drive the two paths.
#
# Run: bash test/benchmarks-update.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
check() { if [ "$1" = "$2" ]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3 (expected '$1', got '$2')" >&2; FAIL=$((FAIL+1)); fi; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/bench-update.XXXXXX")"
BIN="$(mktemp -d "${TMPDIR:-/tmp}/bench-bin.XXXXXX")"
DURABLE="$(mktemp -d "${TMPDIR:-/tmp}/bench-durable.XXXXXX")"
SHADOW="$(mktemp -d "${TMPDIR:-/tmp}/bench-shadow.XXXXXX")"
cleanup() { kill "${SLEEP_PID:-}" 2>/dev/null || true; rm -rf "$SCRATCH" "$BIN" "$DURABLE" "$SHADOW"; }
trap cleanup EXIT

# ── Scratch deployment: script + lib co-located, a docs/benchmark.json, a git repo with an origin ──
mkdir -p "$SCRATCH/tools" "$SCRATCH/docs"
cp "$REPO_DIR/tools/c-thru-benchmarks-update.sh" "$SCRATCH/tools/"
cp "$REPO_DIR/tools/c-thru-lib.sh"               "$SCRATCH/tools/"
git init -q "$SCRATCH"
git -C "$SCRATCH" remote add origin https://github.com/fake/c-thru.git
BASE_JSON='{"baseline":true}'
printf '%s' "$BASE_JSON" > "$SCRATCH/docs/benchmark.json"   # no trailing newline → byte-stable hash

# ── Fake curl on PATH: writes $FAKE_CURL_CONTENT to the -o target, ignores the URL ──
cat > "$BIN/curl" <<'CURL'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && printf '%s' "${FAKE_CURL_CONTENT:-}" > "$out"
exit 0
CURL
chmod +x "$BIN/curl"

# Run the script with shadow vs durable dirs distinct and a controlled fetch body.
run_bench() {  # $1 = fetched content
  (
    export PATH="$BIN:$PATH"
    export CLAUDE_PROFILE_DIR="$SHADOW"   # the ephemeral session shadow (effective resolver)
    export CLAUDE_DIR="$DURABLE"          # the user's durable dir (original resolver)
    export CLAUDE_CONFIG_DIR=""
    export FAKE_CURL_CONTENT="$1"
    unset CLAUDE_ROUTER_NO_BENCHMARK_UPDATE
    bash "$SCRATCH/tools/c-thru-benchmarks-update.sh" >/dev/null 2>&1
  )
}

echo "1. Debounce STAMP is written under the DURABLE dir, NOT the ephemeral shadow"
# Identical fetched content → hashes match → the script touches STAMP and exits.
run_bench "$BASE_JSON"
check "yes" "$([ -f "$DURABLE/.benchmarks-stamp" ] && echo yes || echo no)" "stamp created under durable (cthru_original_profile_dir)"
check "yes" "$([ ! -e "$SHADOW/.benchmarks-stamp" ] && echo yes || echo no)" "stamp NOT under shadow (would mean resolvers swapped)"
rm -f "$DURABLE/.benchmarks-stamp"

echo "2. On content change, SIGHUP is delivered to the proxy pid read from the SHADOW resolver"
# NOTE: this pins benchmarks-update's side (PROXY_PID_FILE=cthru_effective_profile_dir/proxy.pid).
# Pre-existing caveat (out of scope): the proxy itself writes proxy.pid via os.homedir()/.claude,
# which can differ from the shadow when CLAUDE_PROFILE_DIR != ~/.claude — not covered here.
sleep 60 & SLEEP_PID=$!
disown "$SLEEP_PID" 2>/dev/null || true   # silence the shell's "Hangup" job notice when SIGHUP lands
echo "$SLEEP_PID" > "$SHADOW/proxy.pid"
run_bench '{"changed":true}'   # differs from BASE_JSON → mv into place → SIGHUP
sleep 0.3
check "yes" "$(kill -0 "$SLEEP_PID" 2>/dev/null && echo no || echo yes)" "proxy pid received SIGHUP (default-terminated)"
check "yes" "$([ -f "$DURABLE/.benchmarks-stamp" ] && echo yes || echo no)" "stamp refreshed under durable after the update"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
