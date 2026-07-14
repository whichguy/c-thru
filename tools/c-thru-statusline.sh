#!/usr/bin/env bash
# c-thru default statusline: "<model> | <cwd>" + optional fallback overlay.
# Injected by c-thru when the user has no statusLine of their own.
# Always exits 0. Opt out of inject: C_THRU_NO_STATUSLINE=1.
# Skip only the HTTP overlay: C_THRU_STATUSLINE_OVERLAY=0.
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
if command -v jq >/dev/null 2>&1 && [[ -n "$input" ]]; then
  model=$(printf '%s' "$input" | jq -r '.model.id // .model.display_name // "claude"' 2>/dev/null)
  cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null)
  [[ -n "$cwd" ]] && cwd="${cwd/#$HOME/~}"
else
  model="claude"; cwd=""
fi
overlay=""
if [[ "${C_THRU_STATUSLINE_OVERLAY:-1}" != "0" ]]; then
  overlay=$("$ROUTER_REPO_ROOT/tools/c-thru-statusline-overlay.sh" 2>/dev/null)
fi
printf '%s | %s%s' "${model:-claude}" "$cwd" "$overlay"
exit 0
