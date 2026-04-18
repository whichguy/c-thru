#!/usr/bin/env bash
# c-thru Stop hook: emits a one-shot systemMessage when a NEW fallback
# event is observed in ~/.claude/proxy.log. Always exits 0 — this hook
# must never interrupt Claude's normal flow.
set +e
trap 'exit 0' ERR

log_file="$HOME/.claude/proxy.log"
tracker_file="$HOME/.claude/.c-thru-stop-hook-last-ts"

command -v jq >/dev/null 2>&1 || exit 0
[[ -r "$log_file" ]] || exit 0

last_line=$(tail -c 50000 "$log_file" 2>/dev/null | grep '\[fallback\.candidate_success\]' | tail -1)
[[ -n "$last_line" ]] || exit 0

json_payload=$(printf '%s' "$last_line" | grep -oE '\{.*\}$' | head -1)
[[ -n "$json_payload" ]] || exit 0

ts_iso=$(printf '%s' "$last_line" | awk '{print $1}')
last_ms=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${ts_iso%.*}" +%s 2>/dev/null)
[[ "$last_ms" =~ ^[0-9]+$ ]] || exit 0
last_ms=$((last_ms * 1000))

served_by=$(printf '%s' "$json_payload" | jq -r '.candidate // empty' 2>/dev/null)
[[ -n "$served_by" ]] || exit 0

# Prefer terminal_model from the same event line (authoritative correlation).
# Fall back to scanning chain_start only if older proxy log format lacks it.
primary=$(printf '%s' "$json_payload" | jq -r '.terminal_model // empty' 2>/dev/null)
if [[ -z "$primary" ]]; then
  primary=$(tail -c 50000 "$log_file" 2>/dev/null | grep '\[fallback\.chain_start\]' | tail -1 | grep -oE '\{.*\}$' | jq -r '.terminal_model // empty' 2>/dev/null)
fi
[[ -n "$primary" ]] || primary="primary"

last_reported=0
if [[ -r "$tracker_file" ]]; then
  read -r last_reported < "$tracker_file" 2>/dev/null
  [[ "$last_reported" =~ ^[0-9]+$ ]] || last_reported=0
fi
(( last_ms > last_reported )) || exit 0

now_ms=$(($(date +%s) * 1000))
age=$((now_ms - last_ms))
(( age < 120000 )) || exit 0

tmp="${tracker_file}.tmp.$$"
if ! printf '%s' "$last_ms" > "$tmp" 2>/dev/null; then
  exit 0
fi
mv -f "$tmp" "$tracker_file" 2>/dev/null || { rm -f "$tmp"; exit 0; }

msg="c-thru: a fallback just fired — ${primary} → ${served_by} (primary unreachable)."
jq -cn --arg m "$msg" '{systemMessage: $m}' 2>/dev/null || true
exit 0
