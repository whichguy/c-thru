#!/usr/bin/env bash
# Hermetic approved-plan spooler coverage. Curl/open/uname are shims so this
# suite also proves the hook's resolver ladder without binding a real port.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_DIR/tools/c-thru-plan-visibility-hook.sh"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-plan-hook.XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
HOME_DIR="$DIR/home"
spool="$DIR/spool"
shim="$DIR/shim"
open_log="$DIR/open.log"
curl_log="$DIR/curl.log"
mkdir -p "$HOME_DIR" "$spool" "$shim"

printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$OPEN_LOG"\n' > "$shim/open"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$CURL_LOG"\nexit 0\n' > "$shim/curl"
printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' > "$shim/uname"
chmod +x "$shim/open" "$shim/curl" "$shim/uname"

FAIL=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL + 1)); }
expect_file() { [ -f "$1" ] && pass "$2" || fail "$2"; }
expect_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (got '$1', expected '$2')"; }
event_count() { cat "$spool"/events.ndjson "$spool"/events.1.ndjson 2>/dev/null | wc -l | tr -d ' '; }

run_hook() {
  local input="$1"
  shift
  printf '%s' "$input" | env -u CLAUDE_PROXY_PORT -u PROXY_PORT -u CLAUDE_PROXY_USE_OLLAMA_PORT -u C_THRU_PLUGIN_PORT \
    HOME="$HOME_DIR" C_THRU_PLAN_SPOOL="$spool" PATH="$shim:$PATH" OPEN_LOG="$open_log" CURL_LOG="$curl_log" \
    ANTHROPIC_BASE_URL="http://127.0.0.1:45678" "$@" bash "$HOOK" >/dev/null
}

echo "c-thru plan-visibility hook tests"

plan=$'# Approved Plan\n\nShip the dashboard.\n'
approval=$(jq -cn --arg plan "$plan" '{session_id:"sessionaaa",cwd:"/work/repo-alpha",transcript_path:"/tmp/transcript.jsonl",hook_event_name:"PostToolUse",tool_name:"ExitPlanMode",tool_input:{plan:"",planFilePath:""},tool_response:{plan:$plan,planWasEdited:true,filePath:"/tmp/plan.md",isAgent:false}}')
run_hook "$approval"
snapshot=$(jq -r '.snapshot' "$spool/events.ndjson")
expect_file "$spool/$snapshot" "approval writes a snapshot"
expect_eq "$(jq -r '.title' "$spool/events.ndjson")" "Approved Plan" "title derives from first markdown heading"
expect_eq "$(jq -r '.repo' "$spool/events.ndjson")" "repo-alpha" "event records cwd basename"
expect_eq "$(wc -l < "$open_log" | tr -d ' ')" "1" "live proxy auto-opens dashboard once"
grep -q '127.0.0.1:45678/ping' "$curl_log" && pass "port resolver uses scrubbed ANTHROPIC_BASE_URL" || fail "port resolver uses scrubbed ANTHROPIC_BASE_URL"

before=$(event_count)
rejected='{"session_id":"rejected","cwd":"/work/repo-alpha","tool_name":"ExitPlanMode","tool_input":{"plan":"# no"},"tool_response":"User rejected tool use"}'
run_hook "$rejected"
expect_eq "$(event_count)" "$before" "rejected plan exits 0 without spooling"

fallback_file="$DIR/fallback-plan.md"
printf '# File fallback\n\nUse planFilePath.\n' > "$fallback_file"
fallback=$(jq -cn --arg file "$fallback_file" '{session_id:"sessionbbb",cwd:"/work/repo-alpha",tool_name:"ExitPlanMode",tool_input:{plan:"",planFilePath:$file}}')
run_hook "$fallback"
fallback_snapshot=$(tail -n 1 "$spool/events.ndjson" | jq -r '.snapshot')
grep -q 'Use planFilePath' "$spool/$fallback_snapshot" && pass "empty input plan falls back to readable planFilePath" || fail "empty input plan falls back to readable planFilePath"

before=$(event_count)
run_hook 'not json at all'
expect_eq "$(event_count)" "$before" "garbage stdin exits 0 without state"
run_hook "$approval" C_THRU_PLAN_PAGE=0
expect_eq "$(event_count)" "$before" "C_THRU_PLAN_PAGE=0 opts out before spooling"
mkdir -p "$HOME_DIR/.claude"
printf '{"plan_page":false}\n' > "$HOME_DIR/.claude/model-map.overrides.json"
run_hook "$approval"
expect_eq "$(event_count)" "$before" "plan_page false override opts out before spooling"
rm -f "$HOME_DIR/.claude/model-map.overrides.json"

: > "$open_log"
no_open=$(jq -cn --arg plan '# No open' '{session_id:"noopenxx",cwd:"/work/repo-alpha",tool_name:"ExitPlanMode",tool_input:{plan:$plan}}')
run_hook "$no_open" C_THRU_PLAN_AUTOOPEN=0
expect_eq "$(wc -l < "$open_log" | tr -d ' ')" "0" "C_THRU_PLAN_AUTOOPEN=0 suppresses browser launch"

: > "$open_log"
stamp=$(jq -cn --arg plan '# Stamp test' '{session_id:"stampxxx",cwd:"/work/repo-alpha",tool_name:"ExitPlanMode",tool_input:{plan:$plan}}')
run_hook "$stamp"
run_hook "$stamp"
expect_eq "$(wc -l < "$open_log" | tr -d ' ')" "1" "per-session stamp prevents repeat auto-open"
expect_file "$spool/.opened-stampxxx" "auto-open writes its session stamp"
stamp_snapshots=$(tail -n 2 "$spool/events.ndjson" | jq -r '.snapshot' | sort -u | wc -l | tr -d ' ')
expect_eq "$stamp_snapshots" "2" "repeat approvals in one session receive distinct snapshots"

# Two appends race with a forced rotation. Seed records intentionally carry no
# snapshot field, so the final referenced-snapshot assertion concerns every
# actual plan event while the line-count check covers all 1003 durable records.
spool="$DIR/concurrent-spool"
mkdir -p "$spool"
for i in $(seq 1 1001); do printf '{"event":"seed","n":%s}\n' "$i" >> "$spool/events.ndjson"; done
con_a=$(jq -cn --arg plan '# Concurrent A' '{session_id:"concurra-aaaa",cwd:"/work/repo-con",tool_name:"ExitPlanMode",tool_input:{plan:$plan}}')
con_b=$(jq -cn --arg plan '# Concurrent B' '{session_id:"concurrb-bbbb",cwd:"/work/repo-con",tool_name:"ExitPlanMode",tool_input:{plan:$plan}}')
run_hook "$con_a" & a_pid=$!
run_hook "$con_b" & b_pid=$!
wait "$a_pid"; a_status=$?
wait "$b_pid"; b_status=$?
expect_eq "$a_status" "0" "first concurrent hook remains fail-open"
expect_eq "$b_status" "0" "second concurrent hook remains fail-open"
expect_eq "$(event_count)" "1003" "rotation preserves every concurrent event line"
while IFS= read -r snap; do
  [ -z "$snap" ] || expect_file "$spool/$snap" "referenced snapshot $snap exists"
done < <(cat "$spool"/events.ndjson "$spool"/events.1.ndjson 2>/dev/null | jq -r 'select(.snapshot? != null) | .snapshot' 2>/dev/null)

[ "$FAIL" -eq 0 ]
