#!/usr/bin/env bash
# c-thru default statusline wrapper: "<model> | <cwd>" + fallback overlay.
# For users with no existing statusline. Always exits 0.
set +e
trap 'exit 0' ERR

input=$(cat)
if command -v jq >/dev/null 2>&1 && [[ -n "$input" ]]; then
  model=$(printf '%s' "$input" | jq -r '.model.id // .model.display_name // "claude"' 2>/dev/null)
  cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null)
  [[ -n "$cwd" ]] && cwd="${cwd/#$HOME/~}"
else
  model="claude"; cwd=""
fi
overlay=$(bash "$HOME/.claude/tools/c-thru-statusline-overlay" 2>/dev/null)
printf '%s | %s%s' "${model:-claude}" "$cwd" "$overlay"
exit 0
