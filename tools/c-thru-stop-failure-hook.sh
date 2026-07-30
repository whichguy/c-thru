#!/usr/bin/env bash
# ARCH: StopFailure hook — after an API error ends a turn, resurrect the local
# c-thru proxy on the session's frozen port if it is dead.
#
# Claude Code contract (v2.1.209): StopFailure is fire-and-forget — stdout and
# exit codes are ignored. This hook only has side effects (spawn proxy).
# Connection refuse typically arrives as error=server_error (not a dedicated
# connection_error matcher). We gate on server_error|unknown + loopback port.
#
# Does NOT rewrite ANTHROPIC_BASE_URL or retry the failed turn.
# Opt out: C_THRU_NO_RESURRECT=1
# Always exit 0 (fail-open).
set -uo pipefail

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


stdin_data=$(cat || true)
error=""
details=""
if command -v node >/dev/null 2>&1; then
  # Parse without relying on jq; tolerate empty/malformed stdin.
  _parsed="$(printf '%s' "$stdin_data" | node -e '
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d || "{}");
        const err = j.error != null ? String(j.error) : "";
        const det = j.error_details != null ? String(j.error_details)
          : (j.errorDetails != null ? String(j.errorDetails) : "");
        process.stdout.write(err + "\n" + det);
      } catch {
        process.stdout.write("\n");
      }
    });
  ' 2>/dev/null || true)"
  error="$(printf '%s' "$_parsed" | head -n1)"
  details="$(printf '%s' "$_parsed" | tail -n +2)"
elif command -v jq >/dev/null 2>&1; then
  error="$(printf '%s' "$stdin_data" | jq -r '.error // empty' 2>/dev/null || true)"
  details="$(printf '%s' "$stdin_data" | jq -r '.error_details // .errorDetails // empty' 2>/dev/null || true)"
fi

# Primary gates: StopFailure enum values used for transport + residual.
act=0
case "$error" in
  server_error|unknown) act=1 ;;
esac
# Secondary: connection-ish text even if enum drifts.
if [ "$act" -eq 0 ] && [ -n "$details" ]; then
  case "$(printf '%s' "$details" | tr '[:upper:]' '[:lower:]')" in
    *econnrefused*|*connection\ refused*|*connection\ to\ the\ api\ was\ lost*|*econnreset*|*enotfound*|*fetch\ failed*|*socket\ hang\ up*)
      act=1 ;;
  esac
fi
[ "$act" -eq 1 ] || exit 0

[ "${C_THRU_NO_RESURRECT:-0}" = "1" ] && exit 0

PORT=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
  # shellcheck source=c-thru-lib.sh
  . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
  PORT="$(cthru_hook_listen_port)"
fi
[ -n "$PORT" ] || exit 0

# Only local gateways — never spawn for real Anthropic / remote base URLs
# that happen to lack a port we own.
case "${ANTHROPIC_BASE_URL:-}" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*|"")
    # empty BASE_URL with PORT from CLAUDE_PROXY_PORT still ok for local
    ;;
  *)
    exit 0
    ;;
esac

if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-ensure-proxy-on-port.sh" ]; then
  # shellcheck source=c-thru-ensure-proxy-on-port.sh
  . "$ROUTER_REPO_ROOT/tools/c-thru-ensure-proxy-on-port.sh"
  cthru_ensure_proxy_on_port "$PORT" 2>/dev/null || true
fi
exit 0
