---
name: c-thru-install-cli
description: "Bootstrap or re-install the c-thru CLI tools (symlinks under ~/.claude/tools). Run after marketplace plugin install. Use force to re-run."
allowed-tools: "Bash"
---
# Install / re-bootstrap c-thru CLI (Shape C)

This is the **supported** install path for marketplace users. Do **not** rely on
SessionStart to `git clone` (hook timeout is too short).

## Run bootstrap

```bash
export CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
# Prefer plugin-bundled bootstrap, then profile tools, then fail clearly.
BOOT=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/tools/c-thru-plugin-bootstrap.sh" ]; then
  BOOT="${CLAUDE_PLUGIN_ROOT}/tools/c-thru-plugin-bootstrap.sh"
elif [ -f "$HOME/.claude/tools/c-thru-plugin-bootstrap" ]; then
  BOOT="$HOME/.claude/tools/c-thru-plugin-bootstrap"
elif [ -f "$HOME/.claude/tools/c-thru-plugin-bootstrap.sh" ]; then
  BOOT="$HOME/.claude/tools/c-thru-plugin-bootstrap.sh"
fi

if [ -z "$BOOT" ]; then
  echo "c-thru: bootstrap script not found. From a git checkout run: bash install.sh"
  exit 0
fi

# Optional: C_THRU_FORCE_BOOTSTRAP=1 to re-link even if stamp healthy
# Optional: C_THRU_GIT_REMOTE=... for private mirrors
# Optional: C_THRU_SOURCE_REF=v0.2.3 to pin clone
if [ "${ARGUMENTS:-}" = "force" ] || [ "${ARGUMENTS:-}" = "--force" ]; then
  C_THRU_FORCE_BOOTSTRAP=1 bash "$BOOT"
else
  bash "$BOOT"
fi
```

## After success

1. Open a new shell (or ensure `~/.claude/tools` is on PATH).
2. Run: **`cthru`** (not plain `claude`).
3. Optional status: `/c-thru:c-thru-status`

Log: `~/.claude/c-thru-bootstrap.log`

## Private git

```bash
export C_THRU_GIT_REMOTE="git@github.com:whichguy/c-thru.git"
```
