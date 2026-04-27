#!/bin/bash
# Daily-debounced fetch of upstream docs/benchmark.json. SIGHUPs the running
# proxy when the file content actually changed. Best-effort, fail-soft —
# never blocks the user's c-thru session.
#
# Stamp: ~/.claude/.benchmarks-stamp (mtime = last successful run)
# Opt-out: CLAUDE_ROUTER_NO_BENCHMARK_UPDATE=1
#
# Companion to tools/c-thru-self-update.sh; see TODO entry "[benchmarks]".
set -uo pipefail

# Opt-out fast path.
[[ "${CLAUDE_ROUTER_NO_BENCHMARK_UPDATE:-}" == "1" ]] && exit 0

ROUTER_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${CLAUDE_PROFILE_DIR:-${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}}"
STAMP="$PROFILE_DIR/.benchmarks-stamp"
BENCH_PATH="$ROUTER_REPO_ROOT/docs/benchmark.json"
PROXY_PID_FILE="$PROFILE_DIR/proxy.pid"

# 24h debounce — if stamp is fresh, skip silently.
if [[ -f "$STAMP" ]]; then
  age=$(( $(date +%s) - $(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0) ))
  if [[ "$age" -lt 86400 ]]; then
    exit 0
  fi
fi

mkdir -p "$PROFILE_DIR" 2>/dev/null || true

# Discover origin URL of the c-thru repo (script knows its own location).
remote=$(git -C "$ROUTER_REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)
if [[ -z "$remote" ]]; then
  echo "c-thru-benchmarks-update: no git origin found; skipping" >&2
  exit 0
fi

# Normalize git@github.com:foo/bar.git → https://github.com/foo/bar
case "$remote" in
  git@github.com:*)
    https="https://github.com/${remote#git@github.com:}"
    https="${https%.git}"
    ;;
  https://*)
    https="${remote%.git}"
    ;;
  *)
    echo "c-thru-benchmarks-update: unsupported remote '$remote'; skipping" >&2
    exit 0
    ;;
esac

branch=$(git -C "$ROUTER_REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[[ -z "$branch" || "$branch" == "HEAD" ]] && branch="main"

raw_url="${https/github.com/raw.githubusercontent.com}/${branch}/docs/benchmark.json"

tmp=$(mktemp -t c-thru-benchmark.XXXXXX) || exit 0
trap 'rm -f "$tmp"' EXIT

# Fetch upstream — fail-soft on any error.
if ! curl -fsSL --max-time 5 "$raw_url" -o "$tmp" 2>/dev/null; then
  echo "c-thru-benchmarks-update: fetch failed for $raw_url; skipping" >&2
  exit 0
fi

# Validate JSON.
if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tmp" 2>/dev/null; then
  echo "c-thru-benchmarks-update: invalid JSON from $raw_url; skipping" >&2
  exit 0
fi

# Hash compare. If identical, just touch stamp and exit.
new_hash=$(shasum -a 256 "$tmp" 2>/dev/null | awk '{print $1}')
old_hash=""
if [[ -f "$BENCH_PATH" ]]; then
  old_hash=$(shasum -a 256 "$BENCH_PATH" 2>/dev/null | awk '{print $1}')
fi

if [[ -n "$new_hash" && "$new_hash" == "$old_hash" ]]; then
  touch "$STAMP" 2>/dev/null || true
  exit 0
fi

# Different — compute a one-line diff summary BEFORE the move (using both files).
summary="benchmarks refreshed"
if command -v jq >/dev/null 2>&1 && [[ -f "$BENCH_PATH" ]]; then
  added=$(jq -r --slurpfile old "$BENCH_PATH" '
    ($old[0] // {} | keys_unsorted) as $ok
    | (keys_unsorted) as $nk
    | ($nk - $ok) | length' "$tmp" 2>/dev/null || echo "?")
  removed=$(jq -r --slurpfile old "$BENCH_PATH" '
    ($old[0] // {} | keys_unsorted) as $ok
    | (keys_unsorted) as $nk
    | ($ok - $nk) | length' "$tmp" 2>/dev/null || echo "?")
  summary="benchmarks refreshed: +${added} keys, -${removed} keys"
fi

# Atomic mv into place.
if ! mv "$tmp" "$BENCH_PATH" 2>/dev/null; then
  echo "c-thru-benchmarks-update: failed to write $BENCH_PATH; skipping" >&2
  exit 0
fi
trap - EXIT  # tmp now consumed by mv

touch "$STAMP" 2>/dev/null || true
echo "c-thru-benchmarks-update: $summary (${old_hash:0:8}..${new_hash:0:8})" >&2

# SIGHUP the running proxy if alive.
if [[ -f "$PROXY_PID_FILE" ]]; then
  pid=$(cat "$PROXY_PID_FILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    if kill -HUP "$pid" 2>/dev/null; then
      echo "c-thru-benchmarks-update: SIGHUP sent to proxy (pid $pid)" >&2
    else
      echo "c-thru-benchmarks-update: SIGHUP to pid $pid failed" >&2
    fi
  fi
fi

exit 0
