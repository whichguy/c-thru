#!/usr/bin/env bash
# Shape C: one-shot bootstrap for marketplace plugin installs.
# Ensures durable CLI tools (symlinks) + stamp so users run `cthru`.
#
# Idempotent. Safe to call from SessionStart (fail-open: never abort the host).
# Env:
#   C_THRU_FORCE_BOOTSTRAP=1  — re-run even if stamp healthy
#   C_THRU_GIT_REMOTE         — override clone URL
#   C_THRU_BOOTSTRAP_PULL=0   — skip git pull on existing c-thru-src
#   CLAUDE_PROFILE_DIR / CLAUDE_CONFIG_DIR / CLAUDE_DIR

set -uo pipefail

_bs_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_bs_src" ]; do
  _bs_dir=$(cd -P "$(dirname "$_bs_src")" && pwd)
  _bs_src=$(readlink "$_bs_src")
  case "$_bs_src" in /*) ;; *) _bs_src="$_bs_dir/$_bs_src" ;; esac
done
_BS_DIR=$(cd -P "$(dirname "$_bs_src")" && pwd)

# shellcheck source=c-thru-install-core.sh
. "$_BS_DIR/c-thru-install-core.sh"
# shellcheck source=c-thru-setup-messages.sh
. "$_BS_DIR/c-thru-setup-messages.sh" 2>/dev/null || true

CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-${CLAUDE_DIR:-$HOME/.claude}}}"
export CLAUDE_DIR

if [[ "${C_THRU_FORCE_BOOTSTRAP:-0}" != "1" ]] && cthru_stamp_is_healthy; then
  exit 0
fi

# Prefer existing complete checkout if REPO_DIR already set (dev)
if [[ -n "${REPO_DIR:-}" ]] && cthru_repo_is_complete "$REPO_DIR"; then
  :
elif cthru_ensure_source_root_s1; then
  :
else
  # Last resort: if we're inside a full monorepo (developer layout), use it
  _maybe="$(cd "$_BS_DIR/../.." 2>/dev/null && pwd -P || true)"
  if cthru_repo_is_complete "$_maybe"; then
    REPO_DIR="$_maybe"
    export REPO_DIR
  else
    echo "c-thru bootstrap: could not obtain full source tree (need git clone of whichguy/c-thru)" >&2
    exit 0
  fi
fi

if cthru_install_from_repo; then
  if declare -F cthru_msg_after_bootstrap >/dev/null 2>&1; then
    cthru_msg_after_bootstrap >&2
  else
    echo "c-thru CLI tools installed. Launch with: cthru" >&2
  fi
fi
exit 0
