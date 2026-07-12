#!/usr/bin/env bash
# Regression matrix for the opt-in c-thru autonomous Stop-hook gate.
#
# Run: bash test/c-thru-autonomous-gate.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

GATE="$REPO_DIR/tools/c-thru-autonomous-gate.sh"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/c-thru-autonomous-gate-test.XXXXXX")
trap 'rm -rf "$BASE"' EXIT

RUN_STDOUT=""
RUN_STDERR=""
RUN_STATUS=0

new_fixture() {
    mktemp -d "$BASE/fixture.XXXXXX"
}

run_gate() {
    local fixture="$1" payload="$2"
    RUN_STDOUT=$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$fixture" bash "$GATE" 2>"$fixture/stderr")
    RUN_STATUS=$?
    RUN_STDERR=$(<"$fixture/stderr")
}

write_sentinel() {
    local fixture="$1" session="$2" max_blocks="$3" blocks="$4" created="$5"
    printf '{"session_id":"%s","max_blocks":%s,"blocks":%s,"created":"%s"}\n' \
        "$session" "$max_blocks" "$blocks" "$created" > "$fixture/.claude/autonomous-gate.local.json"
}

decision() {
    printf '%s' "$1" | jq -r '.decision // empty' 2>/dev/null || true
}

now_iso() {
    date -u +%Y-%m-%dT%H:%M:%SZ
}

stale_iso() {
    node -e 'process.stdout.write(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"))'
}

payload_this='{"session_id":"this-session","transcript_path":"/tmp/transcript.jsonl"}'

# ---------------------------------------------------------------------------
echo "1. sentinel absent"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude"
    run_gate "$fixture" "$payload_this"
    check "absent sentinel exits 0" "0" "$RUN_STATUS"
    check "absent sentinel emits no block decision" "" "$(decision "$RUN_STDOUT")"
}

# ---------------------------------------------------------------------------
echo "2. valid sentinel with passing checks"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude"
    write_sentinel "$fixture" "this-session" 5 0 "$(now_iso)"
    sentinel="$fixture/.claude/autonomous-gate.local.json"
    before=$(<"$sentinel")
    run_gate "$fixture" "$payload_this"
    check "passing checks exit 0" "0" "$RUN_STATUS"
    check "passing checks emit no block decision" "" "$(decision "$RUN_STDOUT")"
    check "passing checks retain sentinel" "yes" "$([ -f "$sentinel" ] && printf yes || printf no)"
    check "passing checks retain block count" "0" "$(jq -r '.blocks' "$sentinel" 2>/dev/null)"
    check "passing checks leave sentinel unchanged" "$before" "$(<"$sentinel")"
}

# ---------------------------------------------------------------------------
echo "3. failing integrity check increments and blocks atomically"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude" "$fixture/tools"
    write_sentinel "$fixture" "this-session" 5 0 "$(now_iso)"
    printf 'if then\n' > "$fixture/tools/c-thru"
    sentinel="$fixture/.claude/autonomous-gate.local.json"
    run_gate "$fixture" "$payload_this"
    check "failing check exits 0" "0" "$RUN_STATUS"
    check "failing check emits block decision" "block" "$(decision "$RUN_STDOUT")"
    check "failing check increments blocks" "1" "$(jq -r '.blocks' "$sentinel")"
    leftover=$(find "$fixture/.claude" -name '*.tmp.*' -print -quit)
    check "atomic update leaves no temporary sentinel files" "" "$leftover"
}

# ---------------------------------------------------------------------------
echo "4. session mismatch"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude"
    write_sentinel "$fixture" "other-session" 5 2 "$(now_iso)"
    sentinel="$fixture/.claude/autonomous-gate.local.json"
    cp "$sentinel" "$fixture/original-sentinel"
    run_gate "$fixture" "$payload_this"
    check "session mismatch exits 0" "0" "$RUN_STATUS"
    cmp -s "$sentinel" "$fixture/original-sentinel"
    check "session mismatch leaves sentinel byte-for-byte unchanged" "0" "$?"
}

# ---------------------------------------------------------------------------
echo "5. malformed sentinel"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude"
    printf 'not json at all\n' > "$fixture/.claude/autonomous-gate.local.json"
    run_gate "$fixture" "$payload_this"
    check "malformed sentinel exits 0" "0" "$RUN_STATUS"
    check "malformed sentinel is deleted" "no" "$([ -e "$fixture/.claude/autonomous-gate.local.json" ] && printf yes || printf no)"
    check "malformed sentinel warns on stderr" "yes" "$([ -n "$RUN_STDERR" ] && printf yes || printf no)"
}

# ---------------------------------------------------------------------------
echo "6. stale sentinel"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude"
    write_sentinel "$fixture" "this-session" 5 0 "$(stale_iso)"
    run_gate "$fixture" "$payload_this"
    check "stale sentinel exits 0" "0" "$RUN_STATUS"
    check "stale sentinel is deleted" "no" "$([ -e "$fixture/.claude/autonomous-gate.local.json" ] && printf yes || printf no)"
}

# ---------------------------------------------------------------------------
echo "7. exhausted block budget"
{
    fixture=$(new_fixture); mkdir -p "$fixture/.claude"
    write_sentinel "$fixture" "this-session" 5 5 "$(now_iso)"
    run_gate "$fixture" "$payload_this"
    check "exhausted budget exits 0" "0" "$RUN_STATUS"
    check "exhausted budget allows stop without block decision" "" "$(decision "$RUN_STDOUT")"
    check "exhausted budget deletes sentinel" "no" "$([ -e "$fixture/.claude/autonomous-gate.local.json" ] && printf yes || printf no)"
}

# ---------------------------------------------------------------------------
echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
