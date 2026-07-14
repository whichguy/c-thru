#!/usr/bin/env bash
# c-thru statusline overlay: prints a fallback badge when this session's most
# recent request (via GET /c-thru/recent, session-scoped through the /s/<id>
# path prefix) was served by a fallback, else empty. Safe to append to any
# host statusline script. Always exits 0.
#
# Round-5 B3: rewritten from grepping ~/.claude/proxy.log for
# [fallback.candidate_success] — an event name the fallback engine stopped
# emitting; this hook watched a dead string. See c-thru-stop-hook.sh's header
# for the fuller rationale (same rebuild, same data source).
set +e
trap 'exit 0' ERR

_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)

command -v jq >/dev/null 2>&1 || exit 0

BASE_URL=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    BASE_URL="$(cthru_hook_base_url)"
fi
[ -n "$BASE_URL" ] || exit 0

# Keep this on the TUI hot path: Claude refreshes statusline often and waits
# for the command. Cap HTTP well under a second (was 2s) so a slow proxy cannot
# stall redraw while the user types or moves the mouse.
recent_json=$(curl -sf --max-time 0.25 --connect-timeout 0.15 "${BASE_URL}/c-thru/recent?n=5" 2>/dev/null)
[ -n "$recent_json" ] || exit 0

fallback_entry=$(printf '%s' "$recent_json" | jq -c '.requests[]? | select(.fallback_from != null)' 2>/dev/null | head -1)
[ -n "$fallback_entry" ] || exit 0

ts_iso=$(printf '%s' "$fallback_entry" | jq -r '.ts // empty' 2>/dev/null)
[ -n "$ts_iso" ] || exit 0
last_ms=$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isFinite(t))process.stdout.write(String(t))' "$ts_iso" 2>/dev/null)
[[ "$last_ms" =~ ^[0-9]+$ ]] || exit 0

now_ms=$(($(date +%s) * 1000))
age=$((now_ms - last_ms))
(( age < 120000 )) || exit 0

served_by=$(printf '%s' "$fallback_entry" | jq -r '.served_by // empty' 2>/dev/null)
[ -n "$served_by" ] || exit 0

# ASCII only — wide emoji mis-measures columns; no OSC-8 (unreliable in CC TUI).
# Keep standalone for users who append this to a *custom* statusLine.
_short="$served_by"
_short="${_short##*/}"
if (( ${#_short} > 28 )); then _short="${_short:0:27}…"; fi
printf ' [fallback] -> %s' "$_short"
exit 0
