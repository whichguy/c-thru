#!/usr/bin/env bash
# c-thru default statusline (absent-only inject when user has no statusLine).
#
# Styles (C_THRU_STATUSLINE_STYLE or durable ~/.claude/c-thru-statusline.json):
#   minimal — model | cwd
#   default — + last served/tokens + fallback + dash  (GET /c-thru/recent)
#   stats   — + mode|tier + Σ window totals          (GET /c-thru/statusline)
#
# Dual scope (stats style): last hop / fallback follow the session-scoped base
# URL (/s/<id>/…) when set; Σ / usage_window is always the machine-wide
# lifetime ledger since last clear (same file as c-thru stats clear).
#
# Env:
#   C_THRU_NO_STATUSLINE=1       — skip inject entirely (launcher)
#   C_THRU_STATUSLINE_OVERLAY=0  — forces minimal content
#   C_THRU_STATUSLINE_DASH=0     — hide dash when enrichment is on
#   C_THRU_STATUSLINE_STYLE      — minimal|default|stats (overrides pref file)
# Always exits 0. ASCII only — no OSC-8.
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

_recent_ts() {
  local ts_iso="$1" last_ms now_ms age
  [ -n "$ts_iso" ] || return 1
  last_ms=$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isFinite(t))process.stdout.write(String(t))' "$ts_iso" 2>/dev/null)
  [[ "$last_ms" =~ ^[0-9]+$ ]] || return 1
  now_ms=$(($(date +%s) * 1000))
  age=$((now_ms - last_ms))
  (( age < 120000 ))
}

_short_mode() {
  case "$1" in
    best-cloud) echo "cloud" ;;
    best-cloud-oss) echo "oss" ;;
    best-local-oss) echo "local" ;;
    best-cloud-gov) echo "gov" ;;
    best-local-gov) echo "local-gov" ;;
    *) printf '%s' "${1:-?}" ;;
  esac
}

# Resolve style: env > durable pref file > default
_style="${C_THRU_STATUSLINE_STYLE:-}"
if [[ -z "$_style" ]] && command -v jq >/dev/null 2>&1; then
  _pref_dir="${C_THRU_ORIGINAL_PROFILE_DIR:-${CLAUDE_DIR:-$HOME/.claude}}"
  _pref_file="${_pref_dir}/c-thru-statusline.json"
  if [[ -r "$_pref_file" ]]; then
    _style=$(jq -r '.style // empty' "$_pref_file" 2>/dev/null || true)
  fi
fi
_style="${_style:-default}"
_style="$(printf '%s' "$_style" | tr '[:upper:]' '[:lower:]')"

# OVERLAY=0 forces minimal regardless of style
if [[ "${C_THRU_STATUSLINE_OVERLAY:-1}" == "0" ]]; then
  _style="minimal"
fi

extra=""
if [[ "$_style" != "minimal" ]] && command -v jq >/dev/null 2>&1; then
  BASE_URL=""
  PORT=""
  if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    BASE_URL="$(cthru_hook_base_url)"
    PORT="$(cthru_hook_listen_port)"
  fi
  if [ -n "$BASE_URL" ]; then
    if [[ "$_style" == "stats" ]]; then
      # One slim GET for mode/tier/last/Σ
      sl_json=$(curl -sf --max-time 0.8 --connect-timeout 0.3 \
        "${BASE_URL}/c-thru/statusline" 2>/dev/null || true)
      if [ -n "$sl_json" ]; then
        mode=$(printf '%s' "$sl_json" | jq -r '.mode // empty' 2>/dev/null)
        tier=$(printf '%s' "$sl_json" | jq -r '.tier // empty' 2>/dev/null)
        port_j=$(printf '%s' "$sl_json" | jq -r '.port // empty' 2>/dev/null)
        [[ -n "$port_j" && "$port_j" != "null" ]] && PORT="$port_j"
        if [[ -n "$mode" || -n "$tier" ]]; then
          mshort="$(_short_mode "$mode")"
          tshort="${tier%gb}"
          tshort="${tshort%GB}"
          extra+=" | ${mshort}|${tshort}"
        fi
        served=$(printf '%s' "$sl_json" | jq -r '.last.served_by // empty' 2>/dev/null)
        tin=$(printf '%s' "$sl_json" | jq -r '.last.input_tokens // empty' 2>/dev/null)
        tout=$(printf '%s' "$sl_json" | jq -r '.last.output_tokens // empty' 2>/dev/null)
        last_fb=$(printf '%s' "$sl_json" | jq -r '.last.fallback_from // empty' 2>/dev/null)
        fb_model=$(printf '%s' "$sl_json" | jq -r '.fallback.served_by // empty' 2>/dev/null)
        if [[ -n "$last_fb" && "$last_fb" != "null" && -n "$served" ]]; then
          extra+=" | [fallback] -> $(_short_model "$served")"
        elif [[ -n "$served" ]]; then
          extra+=" | $(_short_model "$served")"
        fi
        if [[ "$tin" =~ ^[0-9]+$ ]] || [[ "$tout" =~ ^[0-9]+$ ]]; then
          extra+=" $(_fmt_tok "${tin:-0}")/$(_fmt_tok "${tout:-0}")"
        fi
        if [[ -n "$fb_model" && ( -z "$last_fb" || "$last_fb" == "null" ) ]]; then
          extra+=" | [fallback] -> $(_short_model "$fb_model")"
        fi
        calls=$(printf '%s' "$sl_json" | jq -r '.usage_window.calls // 0' 2>/dev/null)
        uin=$(printf '%s' "$sl_json" | jq -r '.usage_window.input // 0' 2>/dev/null)
        uout=$(printf '%s' "$sl_json" | jq -r '.usage_window.output // 0' 2>/dev/null)
        if [[ "$calls" =~ ^[0-9]+$ ]] && (( calls > 0 )); then
          extra+=" | Σ${calls} $(_fmt_tok "$uin")/$(_fmt_tok "$uout")"
        fi
      fi
    else
      # default: recent ring only
      recent_json=$(curl -sf --max-time 0.8 --connect-timeout 0.3 \
        "${BASE_URL}/c-thru/recent?n=5" 2>/dev/null || true)
      if [ -n "$recent_json" ]; then
        last=$(printf '%s' "$recent_json" | jq -c '.requests[0] // empty' 2>/dev/null)
        show_fallback=""
        fb_model=""
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
          if [ -n "$show_fallback" ] && [ -n "$last_fb" ] && [ "$served" = "$fb_model" ]; then
            extra+=" | [fallback] -> $(_short_model "$fb_model")"
            show_fallback=""
          elif [ -n "$served" ]; then
            extra+=" | $(_short_model "$served")"
          fi
          if [[ "$tin" =~ ^[0-9]+$ ]] || [[ "$tout" =~ ^[0-9]+$ ]]; then
            extra+=" $(_fmt_tok "${tin:-0}")/$(_fmt_tok "${tout:-0}")"
          fi
        fi
        if [ -n "$show_fallback" ] && [ -n "$fb_model" ]; then
          extra+=" | [fallback] -> $(_short_model "$fb_model")"
        fi
      fi
    fi
  fi

  if [[ "${C_THRU_STATUSLINE_DASH:-1}" != "0" ]] && [[ -n "$PORT" ]]; then
    extra+=" | dash :${PORT}/c-thru/dashboard"
  fi
fi

printf '%s | %s%s' "$model" "$cwd" "$extra"
exit 0
