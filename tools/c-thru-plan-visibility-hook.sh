#!/usr/bin/env bash
# ARCH: PostToolUse/ExitPlanMode
# Approved-plan spooler. Fail open by design: visibility must never interrupt a
# Claude Code session, including when JSON tooling or the local proxy is absent.
set -uo pipefail

payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
[ "${C_THRU_PLAN_PAGE:-1}" = "0" ] && exit 0

overrides="${HOME:-}/.claude/model-map.overrides.json"
if [ -r "$overrides" ]; then
  if command -v jq >/dev/null 2>&1; then
    jq -e '.plan_page == false' "$overrides" >/dev/null 2>&1 && exit 0
  elif command -v node >/dev/null 2>&1; then
    node -e 'try { process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).plan_page === false ? 0 : 1); } catch (_) { process.exit(1); }' "$overrides" >/dev/null 2>&1 && exit 0
  fi
fi

if command -v jq >/dev/null 2>&1; then
  response_kind=$(printf '%s' "$payload" | jq -r 'if has("tool_response") then (.tool_response | type) else "absent" end' 2>/dev/null) || exit 0
  session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null) || exit 0
  cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
  transcript_path=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null) || exit 0
  response_plan=$(printf '%s' "$payload" | jq -r 'if (.tool_response | type) == "object" then (.tool_response.plan // empty) else empty end' 2>/dev/null) || exit 0
  input_plan=$(printf '%s' "$payload" | jq -r '.tool_input.plan // empty' 2>/dev/null) || exit 0
  plan_file=$(printf '%s' "$payload" | jq -r '.tool_input.planFilePath // empty' 2>/dev/null) || exit 0
elif command -v node >/dev/null 2>&1; then
  node_value() {
    printf '%s' "$payload" | node -e '
      let raw=""; process.stdin.setEncoding("utf8");
      process.stdin.on("data", c => raw += c);
      process.stdin.on("end", () => {
        try {
          const p = JSON.parse(raw), key = process.argv[1], r = p.tool_response;
          const values = {
            kind: Object.prototype.hasOwnProperty.call(p, "tool_response") ? (r === null ? "null" : typeof r) : "absent",
            session: p.session_id || "", cwd: p.cwd || "", transcript: p.transcript_path || "",
            responsePlan: r && typeof r === "object" ? (r.plan || "") : "",
            inputPlan: p.tool_input && p.tool_input.plan || "",
            planFile: p.tool_input && p.tool_input.planFilePath || "",
          };
          process.stdout.write(String(values[key] || ""));
        } catch (_) {}
      });
    ' "$1" 2>/dev/null
  }
  response_kind=$(node_value kind) || exit 0
  session_id=$(node_value session) || exit 0
  cwd=$(node_value cwd) || exit 0
  transcript_path=$(node_value transcript) || exit 0
  response_plan=$(node_value responsePlan) || exit 0
  input_plan=$(node_value inputPlan) || exit 0
  plan_file=$(node_value planFile) || exit 0
else
  exit 0
fi

[ "$response_kind" = "string" ] && exit 0
plan="$response_plan"
[ -n "$plan" ] || plan="$input_plan"
if [ -z "$plan" ] && [ -n "$plan_file" ] && [ -f "$plan_file" ] && [ -r "$plan_file" ]; then
  plan=$(cat "$plan_file" 2>/dev/null) || plan=""
fi
[ -n "$plan" ] || exit 0

spool="${C_THRU_PLAN_SPOOL:-${HOME:-}/.claude/c-thru/plan-events}"
mkdir -p "$spool" 2>/dev/null || exit 0
if command -v node >/dev/null 2>&1; then
  epoch=$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null) || exit 0
else
  epoch=$(date +%s 2>/dev/null) || exit 0
fi
session8=$(printf '%s' "$session_id" | tr -cd '[:alnum:]_-' | cut -c1-8)
[ -n "$session8" ] || session8="unknown"
while :; do
  snapshot="${epoch}-${session8}.md"
  snapshot_path="$spool/$snapshot"
  ( set -C; : > "$snapshot_path" ) 2>/dev/null && break
  epoch=$((epoch + 1))
done
printf '%s\n' "$plan" > "$snapshot_path" 2>/dev/null || exit 0
title=$(printf '%s\n' "$plan" | sed -n 's/^[[:space:]]*#\{1,\}[[:space:]]*//p' | head -n 1)
if [ -n "$cwd" ]; then repo=$(basename "$cwd" 2>/dev/null || printf 'unknown'); else repo="unknown"; fi

events="$spool/events.ndjson"
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ts "$epoch" --arg session_id "$session_id" --arg cwd "$cwd" --arg repo "$repo" \
    --arg transcript_path "$transcript_path" --arg snapshot "$snapshot" --arg title "$title" \
    '{ts:$ts,event:"plan_approved",session_id:$session_id,cwd:$cwd,repo:$repo,transcript_path:$transcript_path,snapshot:$snapshot,title:$title}' >> "$events" 2>/dev/null || exit 0
elif command -v node >/dev/null 2>&1; then
  node -e 'const [ts,session_id,cwd,repo,transcript_path,snapshot,title] = process.argv.slice(1); process.stdout.write(JSON.stringify({ts,event:"plan_approved",session_id,cwd,repo,transcript_path,snapshot,title}) + "\n");' \
    "$epoch" "$session_id" "$cwd" "$repo" "$transcript_path" "$snapshot" "$title" >> "$events" 2>/dev/null || exit 0
else
  exit 0
fi

# Resolve this hook's real location so direct tools/, symlinked installs, and
# plugins/c-thru/hooks all source the corresponding bundled resolver library.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
  _dir=$(cd -P "$(dirname "$_src")" && pwd)
  _src=$(readlink "$_src")
  case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)
PORT=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
  # shellcheck source=c-thru-lib.sh
  . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
  PORT="$(cthru_hook_listen_port)"
fi

url=""
if [ -n "$PORT" ] && command -v curl >/dev/null 2>&1 && curl -sf --max-time 2 "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; then
  url="http://127.0.0.1:$PORT/c-thru/plan/dashboard"
  echo "plan page: $url" >&2
else
  echo "plan page: snapshot saved to $snapshot_path (proxy not running)" >&2
fi

stamp="$spool/.opened-$session8"
if [ -n "$url" ] && [ "${C_THRU_PLAN_AUTOOPEN:-1}" != "0" ] && [ "$(uname 2>/dev/null || true)" = "Darwin" ] \
  && command -v open >/dev/null 2>&1 && [ ! -e "$stamp" ]; then
  if open "$url" >/dev/null 2>&1; then touch "$stamp" 2>/dev/null || true; fi
fi

# Lock-free append above is the durability point. Rotation uses a non-blocking
# mkdir lock: a concurrent hook that cannot acquire it simply leaves pruning to
# a later approval, never rewriting the active log in place.
line_count=$(wc -l < "$events" 2>/dev/null) || line_count=0
if mkdir "$spool/.prune.lock" 2>/dev/null; then
  if [ "${line_count:-0}" -gt 1000 ]; then
    mv -f "$events" "$spool/events.1.ndjson" 2>/dev/null || true
  fi
  ls -1t "$spool"/*.md 2>/dev/null | awk 'NR > 50' | while IFS= read -r old_snapshot; do
    rm -f "$old_snapshot" 2>/dev/null || true
  done
  rmdir "$spool/.prune.lock" 2>/dev/null || true
fi
exit 0
