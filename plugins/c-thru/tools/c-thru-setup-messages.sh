#!/usr/bin/env bash
# Shared Shape C user-facing setup messages for install.sh + plugin bootstrap.
# Source only (function defs). Do not execute directly.
#
# Canonical product story:
#   marketplace install → bootstrap CLI tools → run `cthru` (not plain claude)

cthru_msg_runtime_cli() {
  cat <<'EOF'
c-thru Shape C: runtime is the CLI wrapper.
  Launch with:  cthru
  (or:          c-thru)
  Do not use plain `claude` for full routing + agent fleet.
EOF
}

cthru_msg_after_cli_install() {
  cat <<'EOF'
CLI path active: tools under $HOME/.claude/tools (c-thru / cthru on PATH).
Runtime: always launch with `cthru` (or `c-thru`).

Do not also enable marketplace plugin routing hooks while using CLI inject
(hooks would double-fire). Prefer one path:
  • Full product: CLI only (`cthru`) after install.sh / bootstrap
  • Marketplace plugin: install once to bootstrap, then switch to `cthru`
EOF
}

cthru_msg_after_bootstrap() {
  cat <<'EOF'
c-thru CLI tools installed (symlinks under ~/.claude/tools).
Next: open a new terminal (or source your shell rc), then run:

  cthru

Full routing + agent fleet require the CLI launcher — not plain `claude`.
EOF
}

cthru_msg_pick_one_identity() {
  cat <<'EOF'
Pick exactly one marketplace identity (never both):
  /plugin marketplace add whichguy/c-thru
  /plugin install c-thru@c-thru
  # or family: whichguy/claude-craft → c-thru@claude-craft
EOF
}

cthru_msg_remove() {
  cat <<'EOF'
Removing c-thru (order matters):
  1. pkill -f claude-proxy   # required — orphan proxy can mask the brick
  2. bash uninstall.sh       # CLI: scrubs loopback ANTHROPIC_BASE_URL + tools
     # or manually delete env.ANTHROPIC_BASE_URL if it is http://127.0.0.1:…
  3. /plugin uninstall c-thru@…   # last — plugin uninstall alone is not enough
EOF
}
