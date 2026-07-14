#!/usr/bin/env bash
# c-thru default statusline (absent-only inject when user has no statusLine).
#
#   <model> | <cwd> | <served> <in>/<out> | [fallback] -> <m> | dash :PORT
#
# One cheap GET /c-thru/recent (≤0.25s). ASCII only — no OSC-8 links (Claude
# Code statusline hyperlink support is unreliable). Plain dashboard host:port
# is printable so users can open it manually.
#
# Env:
#   C_THRU_NO_STATUSLINE=1       — skip inject entirely (launcher)
#   C_THRU_STATUSLINE_OVERLAY=0  — no fallback badge / last-served / tokens
#   C_THRU_STATUSLINE_DASH=0     — hide dashboard hint
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

# Shorten long provider tags for the bar (keep last path segment, cap length).
_short_model() {
  local m="$1"
  m="${m##*/}"
  m="${m##*:}"
  if (( ${#m} > 28 )); then
    printf '%s…' "${m:0:27}"
  else
    printf '%s' "$m"
  fi
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
    recent_json=$(curl -sf --max-time 0.25 --connect-timeout 0.15 \
      "${BASE_URL}/c-thru/recent?n=5" 2>/dev/null)
    if [ -n "$recent_json" ]; then
      # Newest request for last-served + tokens
      last=$(printf '%s' "$recent_json" | jq -c '.requests[0] // empty' 2>/dev/null)
      if [ -n "$last" ] && [ "$last" != "null" ]; then
        served=$(printf '%s' "$last" | jq -r '.served_by // empty' 2>/dev/null)
        tin=$(printf '%s' "$last" | jq -r '.input_tokens // empty' 2>/dev/null)
        tout=$(printf '%s' "$last" | jq -r '.output_tokens // empty' 2>/dev/null)
        if [ -n "$served" ]; then
          extra+=" | $(_short_model "$served")"
        fi
        if [[ "$tin" =~ ^[0-9]+$ ]] || [[ "$tout" =~ ^[0-9]+$ ]]; then
          tin_s=$(_fmt_tok "${tin:-0}")
          tout_s=$(_fmt_tok "${tout:-0}")
          extra+=" ${tin_s}/${tout_s}"
        fi
      fi

      # Fallback badge if any recent request in last 120s used fallback
      fallback_entry=$(printf '%s' "$recent_json" | jq -c \
        '.requests[]? | select(.fallback_from != null)' 2>/dev/null | head -1)
      if [ -n "$fallback_entry" ]; then
        ts_iso=$(printf '%s' "$fallback_entry" | jq -r '.ts // empty' 2>/dev/null)
        if [ -n "$ts_iso" ]; then
          last_ms=$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isFinite(t))process.stdout.write(String(t))' "$ts_iso" 2>/dev/null)
          if [[ "$last_ms" =~ ^[0-9]+$ ]]; then
            now_ms=$(($(date +%s) * 1000))
            age=$((now_ms - last_ms))
            if (( age < 120000 )); then
              fb=$(printf '%s' "$fallback_entry" | jq -r '.served_by // empty' 2>/dev/null)
              if [ -n "$fb" ]; then
                extra+=" | [fallback] -> $(_short_model "$fb")"
              fi
            fi
          fi
        fi
      fi
    fi
  fi

  if [[ "${C_THRU_STATUSLINE_DASH:-1}" != "0" ]] && [[ -n "$PORT" ]]; then
    # Plain text only (no OSC-8). Open in browser: open http://127.0.0.1:PORT/c-thru/dashboard
    extra+=" | dash :${PORT}/c-thru/dashboard"
  fi
fi

printf '%s | %s%s' "$model" "$cwd" "$extra"
exit 0
