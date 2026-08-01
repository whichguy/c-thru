#!/usr/bin/env bash
# c-thru Stop hook: emits a one-shot systemMessage when a NEW routing event
# is observed via the proxy's GET /c-thru/recent (session-scoped through the
# /s/<id> path prefix — see cthru_hook_base_url in c-thru-lib.sh, so this
# only ever reports THIS session's own events, not another session's on a
# shared proxy).
#
# Events reported (priority: brand hard-fail > successful cascade):
#   1. fallback_suppressed / on_failure=hard_fail with !ok — brand/model pin
#      failed without substitute (e.g. xAI 403 credits). Message names the
#      agent and status class (billing/auth vs error), never "primary unreachable".
#   2. fallback_from set with ok — cascade substitution; does not claim
#      "unreachable" for every case (primary may have been 403/429).
#
# Always exits 0 — this hook must never interrupt Claude's normal flow.
set +e
trap 'exit 0' ERR

# Resolve script location (follow symlinks) so the shared resolver lib is
# found via symlink, repo direct, or plugin bundle — matches the other hooks.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)
# Plugin-manifest gate (C_THRU_PLUGIN_HOOK=1): skip under cthru / Shape C stamp
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-plugin-hook-gate.sh" ]; then
    # shellcheck source=c-thru-plugin-hook-gate.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-plugin-hook-gate.sh"
    if cthru_plugin_hook_should_skip; then
        exit 0
    fi
fi


command -v jq >/dev/null 2>&1 || exit 0

BASE_URL=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    BASE_URL="$(cthru_hook_base_url)"
fi
[ -n "$BASE_URL" ] || exit 0  # c-thru not active (or lib unavailable — fail open)

tracker_file="$HOME/.claude/.c-thru-stop-hook-last-ts"

recent_json=$(curl -sf --max-time 2 "${BASE_URL}/c-thru/recent?n=20" 2>/dev/null || true)
[ -n "$recent_json" ] || exit 0

# Prefer newest brand hard-fail; else newest successful cascade.
# Ring is newest-first in API responses (proxy reverses before send).
event_entry=$(printf '%s' "$recent_json" | jq -c '
  (.requests // [])
  | map(select(
      (.fallback_suppressed == true or .on_failure == "hard_fail")
      and (.ok == false)
      and ((.status // 0) >= 400)
    ))
  | .[0]
' 2>/dev/null)
event_kind="hard_fail"
if [ -z "$event_entry" ] || [ "$event_entry" = "null" ]; then
  event_entry=$(printf '%s' "$recent_json" | jq -c '
    (.requests // [])
    | map(select(.fallback_from != null and .fallback_from != ""))
    | .[0]
  ' 2>/dev/null)
  event_kind="fallback"
fi
[ -n "$event_entry" ] && [ "$event_entry" != "null" ] || exit 0

ts_iso=$(printf '%s' "$event_entry" | jq -r '.ts // empty' 2>/dev/null)
[ -n "$ts_iso" ] || exit 0
# Portable ISO-8601 → epoch-ms via node (avoids BSD-vs-GNU `date` divergence).
last_ms=$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isFinite(t))process.stdout.write(String(t))' "$ts_iso" 2>/dev/null)
[[ "$last_ms" =~ ^[0-9]+$ ]] || exit 0

last_reported=0
if [ -r "$tracker_file" ]; then
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

primary=$(printf '%s' "$event_entry" | jq -r '.model // "primary"' 2>/dev/null)
served_by=$(printf '%s' "$event_entry" | jq -r '.served_by // empty' 2>/dev/null)
agent=$(printf '%s' "$event_entry" | jq -r '.agent // empty' 2>/dev/null)
status=$(printf '%s' "$event_entry" | jq -r '.status // empty' 2>/dev/null)
who="${agent:-$primary}"

if [ "$event_kind" = "hard_fail" ]; then
  # Permanent-class statuses (auth/billing/ACL) vs generic failure.
  case "$status" in
    401) class="auth failed (401) — check API key / subscription token" ;;
    403) class="permission denied (403) — often billing/spend limit or model ACL; key set ≠ usable" ;;
    404) class="not found (404) — model/endpoint entitlement" ;;
    *)   class="HTTP ${status:-error} — cascade suppressed (brand/model pin hard_fail)" ;;
  esac
  msg="c-thru: brand/model pin '${who}' failed (${class}). No substitute was used. Fix the primary backend; do not invent that brand's answer."
else
  [ -n "$served_by" ] || exit 0
  agent_note=""
  [ -n "$agent" ] && agent_note=" [agent=${agent}]"
  msg="c-thru: a fallback just fired — ${primary} → ${served_by}${agent_note} (primary did not serve; check /c-thru/recent for status)."
fi

jq -cn --arg m "$msg" '{systemMessage: $m}' 2>/dev/null || true
exit 0
