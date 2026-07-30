#!/usr/bin/env bash
# c-thru Stop hook: emits a one-shot systemMessage when a NEW fallback event
# is observed via the proxy's GET /c-thru/recent (session-scoped through the
# /s/<id> path prefix — see cthru_hook_base_url in c-thru-lib.sh, so this
# only ever reports THIS session's own fallbacks, not another session's on a
# shared proxy).
#
# Round-5 B3: rewritten. The prior version grepped ~/.claude/proxy.log for
# [fallback.candidate_success]/[fallback.chain_start] — event names the
# fallback engine stopped emitting when it moved to req-correlated
# dispatch-time logging; this hook was a silent permanent no-op watching
# dead strings. The proxy already tracks per-request fallback attribution
# in its in-memory recent-requests ring (fallback_from/served_by fields),
# exposed at GET /c-thru/recent — this hook now reads that instead of
# re-deriving anything from raw logs.
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

# Ring is newest-first; the first entry with fallback_from set is the most
# recent fallback for this session.
fallback_entry=$(printf '%s' "$recent_json" | jq -c '.requests[]? | select(.fallback_from != null)' 2>/dev/null | head -1)
[ -n "$fallback_entry" ] || exit 0

ts_iso=$(printf '%s' "$fallback_entry" | jq -r '.ts // empty' 2>/dev/null)
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

# `model` is the client's originally-requested capability/model name
# (captured before rewriting); `served_by` is what actually served the
# response after the fallback.
primary=$(printf '%s' "$fallback_entry" | jq -r '.model // "primary"' 2>/dev/null)
served_by=$(printf '%s' "$fallback_entry" | jq -r '.served_by // empty' 2>/dev/null)
[ -n "$served_by" ] || exit 0

msg="c-thru: a fallback just fired — ${primary} → ${served_by} (primary unreachable)."
jq -cn --arg m "$msg" '{systemMessage: $m}' 2>/dev/null || true
exit 0
