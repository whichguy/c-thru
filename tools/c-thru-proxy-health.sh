#!/usr/bin/env bash
# c-thru proxy health check — UserPromptSubmit hook
# Derive port from explicit env var or from ANTHROPIC_BASE_URL set by c-thru.
# A13: `-u` catches unset-var bugs; `-e` off so curl failure falls through to exit 2.
set -uo pipefail

# Resolve script location (follow symlinks) so the shared resolver lib is found
# whether invoked via ~/.claude/tools symlink, repo direct, or plugin bundle.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)

# Reuse the canonical hook port ladder (CLAUDE_PROXY_PORT → PROXY_PORT →
# USE_OLLAMA_PORT → ANTHROPIC_BASE_URL → plugin default) instead of a partial
# inline sed. Fail-open: if the lib is unreadable, PORT stays empty and the
# guard below no-ops (same as "c-thru not active").
PORT=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    PORT="$(cthru_hook_listen_port)"
fi
[ -n "$PORT" ] || exit 0
curl -sf --max-time 2 "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1 && exit 0
echo "c-thru: proxy unreachable on :${PORT} — run: pkill -f claude-proxy" >&2
exit 0
