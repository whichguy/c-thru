#!/usr/bin/env bash
# c-thru default statusline (absent-only inject when user has no statusLine).
#
#   <model> | <cwd> | <served> <in>/<out> | [fallback] -> <m> | dash :PORT
#
# One cheap GET /c-thru/recent (≤0.8s). ASCII only — no OSC-8 links (Claude
# Code statusline hyperlink support is unreliable). Plain dashboard host:port
# is printable so users can open it manually.
#
# Env:
#   C_THRU_NO_STATUSLINE=1       — skip inject entirely (launcher)
#   C_THRU_STATUSLINE_OVERLAY=0  — model|cwd only (no /c-thru/recent, fallback, or dash)
#   C_THRU_STATUSLINE_DASH=0     — hide dash when overlay path is still on
# Always exits 0.
set +e
trap 'exit 0' ERR

_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)

input=$(cat)
model="claude"
cwd=""
if command -v jq >/dev/null 2>&1 && [[ -n "$input" ]]; then
  model=$(printf '%s' "$input" | jq -r '.model.id // .model.display_name // "claude"' 2>/dev/null)
  cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null)
  [[ -n "$cwd" ]] && cwd="${cwd/#$HOME/~}"
fi
model="${model:-claude}"

# Compact token counts: 1234 -> 1.2k, 999 -> 999
_fmt_tok() {
  local n="$1"
  [[ "$n" =~ ^[0-9]+$ ]] || { printf '%s' "$n"; return; }
  if (( n >= 1000000 )); then
    awk -v n="$n" 'BEGIN { printf "%.1fM", n/1000000 }'
  elif (( n >= 1000 )); then
    awk -v n="$n" 'BEGIN { printf "%.1fk", n/1000 }'
  else
    printf '%s' "$n"
  fi
}

# Shorten long provider tags for the bar (last path/tag segment, cap length).
# ASCII "..." only — unicode ellipsis is wide and fights the TUI column budget.
_short_model() {
  local m="$1"
  m="${m##*/}"
  m="${m##*:}"
  if (( ${#m} > 28 )); then
    printf '%s...' "${m:0:25}"
  else
    printf '%s' "$m"
  fi
}

# True if ISO timestamp is within the last 120s (empty/invalid → false).
_recent_ts() {
  local ts_iso="$1" last_ms now_ms age
  [ -n "$ts_iso" ] || return 1
  last_ms=$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isFinite(t))process.stdout.write(String(t))' "$ts_iso" 2>/dev/null)
  [[ "$last_ms" =~ ^[0-9]+$ ]] || return 1
  now_ms=$(($(date +%s) * 1000))
  age=$((now_ms - last_ms))
  (( age < 120000 ))
}

extra=""
if [[ "${C_THRU_STATUSLINE_OVERLAY:-1}" != "0" ]] && command -v jq >/dev/null 2>&1; then
  BASE_URL=""
  PORT=""
  if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    BASE_URL="$(cthru_hook_base_url)"
    PORT="$(cthru_hook_listen_port)"
  fi
  if [ -n "$BASE_URL" ]; then
    # A failed/timed-out curl must not trip the ERR trap above — that would
    # exit 0 with NO output, discarding the already-computed model|cwd line.
    # The `|| true` keeps this an optional enrichment, not an all-or-nothing gate.
    recent_json=$(curl -sf --max-time 0.8 --connect-timeout 0.3 \
      "${BASE_URL}/c-thru/recent?n=5" 2>/dev/null || true)
    if [ -n "$recent_json" ]; then
      last=$(printf '%s' "$recent_json" | jq -c '.requests[0] // empty' 2>/dev/null)
      show_fallback=""
      fb_model=""
      # Prefer a fresh fallback badge over duplicating the same served_by twice.
      fallback_entry=$(printf '%s' "$recent_json" | jq -c \
        '.requests[]? | select(.fallback_from != null)' 2>/dev/null | head -1)
      if [ -n "$fallback_entry" ]; then
        ts_iso=$(printf '%s' "$fallback_entry" | jq -r '.ts // empty' 2>/dev/null)
        if _recent_ts "$ts_iso"; then
          fb_model=$(printf '%s' "$fallback_entry" | jq -r '.served_by // empty' 2>/dev/null)
          [ -n "$fb_model" ] && show_fallback=1
        fi
      fi

      if [ -n "$last" ] && [ "$last" != "null" ]; then
        served=$(printf '%s' "$last" | jq -r '.served_by // empty' 2>/dev/null)
        tin=$(printf '%s' "$last" | jq -r '.input_tokens // empty' 2>/dev/null)
        tout=$(printf '%s' "$last" | jq -r '.output_tokens // empty' 2>/dev/null)
        last_fb=$(printf '%s' "$last" | jq -r '.fallback_from // empty' 2>/dev/null)
        # If newest request is the fallback, one badge + tokens; else show served.
        if [ -n "$show_fallback" ] && [ -n "$last_fb" ] && [ "$served" = "$fb_model" ]; then
          extra+=" | [fallback] -> $(_short_model "$fb_model")"
          show_fallback=""  # already rendered
        elif [ -n "$served" ]; then
          extra+=" | $(_short_model "$served")"
        fi
        if [[ "$tin" =~ ^[0-9]+$ ]] || [[ "$tout" =~ ^[0-9]+$ ]]; then
          tin_s=$(_fmt_tok "${tin:-0}")
          tout_s=$(_fmt_tok "${tout:-0}")
          extra+=" ${tin_s}/${tout_s}"
        fi
      fi
      # Fallback on an older ring entry (newest was healthy) — still surface it.
      if [ -n "$show_fallback" ] && [ -n "$fb_model" ]; then
        extra+=" | [fallback] -> $(_short_model "$fb_model")"
      fi
    fi
  fi

  if [[ "${C_THRU_STATUSLINE_DASH:-1}" != "0" ]] && [[ -n "$PORT" ]]; then
    # Plain text only (no OSC-8). Open: open http://127.0.0.1:PORT/c-thru/dashboard
    extra+=" | dash :${PORT}/c-thru/dashboard"
  fi
fi

printf '%s | %s%s' "$model" "$cwd" "$extra"
exit 0
