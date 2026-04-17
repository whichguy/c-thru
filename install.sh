#!/usr/bin/env bash
# c-thru installer: symlinks router/proxy + helpers into ~/.claude/tools/
# and seeds a user-level model-map on first run.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
TOOLS_SRC="$REPO_DIR/tools"
TOOLS_DEST="$CLAUDE_DIR/tools"

echo -e "${YELLOW}🔧 Installing c-thru (claude-router) from ${REPO_DIR}${NC}"

if [ ! -d "$TOOLS_SRC" ]; then
    echo -e "${RED}❌ Missing ${TOOLS_SRC}${NC}" >&2
    exit 1
fi

chmod +x "$TOOLS_SRC/claude-router" "$TOOLS_SRC/claude-proxy" 2>/dev/null || true
chmod +x "$TOOLS_SRC"/*.js 2>/dev/null || true
chmod +x "$TOOLS_SRC/verify-llm-capabilities-mcp.sh" 2>/dev/null || true

mkdir -p "$TOOLS_DEST"

link_tool() {
    local src="$1" dest_name="$2"
    local dest="$TOOLS_DEST/$dest_name"
    if [ -x "$TOOLS_SRC/$src" ]; then
        if [ -e "$dest" ] && [ ! -L "$dest" ]; then
            echo -e "${YELLOW}⚠️  ${dest} exists and is not a symlink — overwriting with symlink${NC}"
        fi
        ln -sfn "$TOOLS_SRC/$src" "$dest"
        echo -e "${GREEN}✅ Installed tool: ${dest_name}${NC}"
    fi
}

link_tool claude-router claude-router
link_tool claude-proxy claude-proxy
if command -v node >/dev/null 2>&1; then
    link_tool llm-capabilities-mcp.js llm-capabilities-mcp
    link_tool model-map-validate.js model-map-validate
    link_tool model-map-sync.js model-map-sync
    link_tool model-map-edit.js model-map-edit
else
    echo -e "${YELLOW}⚠️  node not found — skipping JS helper symlinks (install Node.js to enable them)${NC}"
fi
link_tool verify-llm-capabilities-mcp.sh verify-llm-capabilities-mcp

# Migrate legacy providers schema if present
migrate_providers_schema() {
    local file="$1"
    [ -f "$file" ] || return 0
    jq -e '.providers' "$file" >/dev/null 2>&1 || return 0

    local timestamp
    timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup="${file}.bak.${timestamp}"
    cp "$file" "$backup"
    echo -e "${YELLOW}⚠️  Migrating legacy 'providers' schema in ${file}${NC}"
    echo -e "${YELLOW}    Backup saved to: ${backup}${NC}"

    # Warn about fields that cannot be mapped
    local dropped
    dropped=$(jq -r '.providers | to_entries[] | select(.value | has("config_dir") or has("env") or has("auth_token") and .auth_token != "ollama") | .key' "$file" 2>/dev/null || true)
    if [ -n "$dropped" ]; then
        echo -e "${YELLOW}    ⚠️  The following provider entries have fields (config_dir, env, auth_token) that cannot be automatically migrated — review the output manually:${NC}"
        echo "$dropped" | while IFS= read -r k; do echo -e "${YELLOW}       - ${k}${NC}"; done
    fi

    local migrated tmp
    migrated=$(jq '
      .providers as $prov |
      . + {
        backends: (
          (.backends // {}) + (
            $prov | to_entries | map(
              .key as $k | .value as $v |
              if ($v.auth_token == "ollama")
              then {key: $k, value: {kind: "ollama", url: ($v.base_url // "")}}
              else {key: $k, value: {kind: "anthropic", url: ($v.base_url // ""), auth_env: "ANTHROPIC_API_KEY"}}
              end
            ) | from_entries
          )
        ),
        model_routes: (
          (.model_routes // {}) + ($prov | keys | map({key: ., value: .}) | from_entries)
        )
      } | del(.providers)
    ' "$file")
    tmp="${file}.tmp.$$"
    printf '%s\n' "$migrated" > "$tmp"
    mv "$tmp" "$file"

    local count
    count=$(printf '%s' "$migrated" | jq '.backends | length')
    echo -e "${GREEN}✅ Migrated ${count} provider(s) → backends + model_routes${NC}"
}

# Seed user-level model-map on first install
USER_MAP="$CLAUDE_DIR/model-map.json"
if [ -f "$USER_MAP" ]; then
    migrate_providers_schema "$USER_MAP"
    echo -e "${YELLOW}ℹ️  User model-map already present: ${USER_MAP}${NC}"
elif [ -f "$REPO_DIR/config/model-map.json" ]; then
    cp "$REPO_DIR/config/model-map.json" "$USER_MAP"
    echo -e "${GREEN}✅ Seeded user model-map: ${USER_MAP}${NC}"
else
    echo -e "${YELLOW}ℹ️  No config/model-map.json found; skipping seed. Copy manually if needed.${NC}"
fi

echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  • ~/.claude/tools/claude-router --list  — list routes / local models"
echo "  • ~/.claude/tools/model-map-validate    — validate profile/project model-map configs"
echo "  • ~/.claude/tools/llm-capabilities-mcp  — local MCP server for logical-LLM tools"
echo "  • tail ~/.claude/proxy.*.log            — troubleshoot proxy startup or routing"
echo "  • pkill -f claude-proxy                 — restart proxy after config edits"
echo "  • CLAUDE_PROXY_BYPASS=1 claude ...      — bypass proxy for direct Anthropic access"
echo ""
echo -e "${GREEN}✅ Done.${NC}"
