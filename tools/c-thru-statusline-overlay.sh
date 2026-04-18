#!/usr/bin/env bash
# c-thru statusline overlay: prints a fallback badge when a recent
# [fallback.candidate_success] event is in ~/.claude/proxy.log, else empty.
# Safe to append to any host statusline script. Always exits 0.
set +e
trap 'exit 0' ERR

command -v jq >/dev/null 2>&1 || exit 0
log_file="$HOME/.claude/proxy.log"
[[ -r "$log_file" ]] || exit 0

last_line=$(tail -c 50000 "$log_file" 2>/dev/null | grep '\[fallback\.candidate_success\]' | tail -1)
[[ -n "$last_line" ]] || exit 0

ts_iso=$(printf '%s' "$last_line" | awk '{print $1}')
last_ms=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${ts_iso%.*}" +%s 2>/dev/null)
[[ "$last_ms" =~ ^[0-9]+$ ]] || exit 0
last_ms=$((last_ms * 1000))

now_ms=$(($(date +%s) * 1000))
age=$((now_ms - last_ms))
(( age < 120000 )) || exit 0

json_payload=$(printf '%s' "$last_line" | grep -oE '\{.*\}$' | head -1)
served_by=$(printf '%s' "$json_payload" | jq -r '.candidate // empty' 2>/dev/null)
[[ -n "$served_by" ]] || exit 0

printf ' ⚠️  FALLBACK → %s' "$served_by"
exit 0
