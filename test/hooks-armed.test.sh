#!/usr/bin/env bash
# Fail-closed guard: the repo ships pre-commit checks in .githooks/, but git only
# runs them when core.hooksPath points there — and that activation is per-clone,
# manual, and silently lost (this clone ran multiple sessions with the gate
# disarmed via a stale absolute .git/hooks pin, which is how bundle drift landed
# despite "pre-commit fails closed on drift" being the design).
#
# Fails iff .githooks/ exists in the repo AND core.hooksPath does not resolve to
# it. Fresh clones fail by design — that is the approved fail-closed behavior;
# the failure message contains the one-command fix. Plugin/tarball consumers
# without .githooks/ are unaffected (and run-all is dev-only anyway).
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Nothing to enforce if the repo doesn't ship hooks.
if [[ ! -d "$REPO_DIR/.githooks" ]]; then
  echo "no .githooks/ directory — nothing to enforce"
  exit 0
fi

configured="$(git -C "$REPO_DIR" config core.hooksPath 2>/dev/null || true)"

# Normalize to a physical absolute path; empty if the directory doesn't exist.
resolve_dir() {
  ( cd -P "$1" 2>/dev/null && pwd )
}

expected="$(resolve_dir "$REPO_DIR/.githooks")"
actual=""
if [[ -n "$configured" ]]; then
  case "$configured" in
    /*) actual="$(resolve_dir "$configured")" ;;
    *)  actual="$(resolve_dir "$REPO_DIR/$configured")" ;;
  esac
fi

if [[ -n "$actual" && "$actual" == "$expected" ]]; then
  echo "core.hooksPath armed: $configured → $actual"
  exit 0
fi

echo "pre-commit hooks are DISARMED in this clone:" >&2
echo "  core.hooksPath = ${configured:-<unset>} (must resolve to $expected)" >&2
echo "  Fix: git config core.hooksPath .githooks" >&2
exit 1
