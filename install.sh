#!/usr/bin/env bash
# c-thru installer: symlinks router/proxy + helpers into ~/.claude/tools/
# and seeds a user-level model-map on first run.
# Safe to re-run: each step checks current state before acting.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
TOOLS_SRC="$REPO_DIR/tools"
TOOLS_DEST="$CLAUDE_DIR/tools"

echo -e "${YELLOW}🔧 c-thru installer — ${REPO_DIR}${NC}"

if [ ! -d "$TOOLS_SRC" ]; then
    echo -e "${RED}❌ Missing ${TOOLS_SRC}${NC}" >&2
    exit 1
fi

chmod +x "$TOOLS_SRC/claude-router" "$TOOLS_SRC/claude-proxy" 2>/dev/null || true
chmod +x "$TOOLS_SRC"/*.js 2>/dev/null || true
chmod +x "$TOOLS_SRC/verify-llm-capabilities-mcp.sh" 2>/dev/null || true

mkdir -p "$TOOLS_DEST"

# --- Idempotent symlink helper ---
# Prints:
#   ✓  name            — already correct, nothing to do
#   ✅ name            — created or updated (target changed)
#   ⚠️  name           — exists as a real file, not a symlink; skipped
link_tool() {
    local src="$1" dest_name="$2"
    local dest="$TOOLS_DEST/$dest_name"
    local want="$TOOLS_SRC/$src"
    [ -x "$want" ] || return 0

    if [ -L "$dest" ]; then
        local current
        current="$(readlink "$dest")"
        if [ "$current" = "$want" ]; then
            echo -e "  ${GRAY}✓  ${dest_name}${NC}"
            return 0
        fi
        ln -sfn "$want" "$dest"
        echo -e "  ${GREEN}✅ ${dest_name} — updated (was: ${current})${NC}"
    elif [ -e "$dest" ]; then
        echo -e "  ${YELLOW}⚠️  ${dest_name} — exists as a real file, not a symlink; skipping${NC}"
    else
        ln -sfn "$want" "$dest"
        echo -e "  ${GREEN}✅ ${dest_name} — installed${NC}"
    fi
}

echo ""
echo "Tools:"
link_tool claude-router claude-router
link_tool claude-router c-thru
link_tool claude-proxy claude-proxy
if command -v node >/dev/null 2>&1; then
    link_tool llm-capabilities-mcp.js llm-capabilities-mcp
    link_tool model-map-validate.js model-map-validate
    link_tool model-map-sync.js model-map-sync
    link_tool model-map-edit.js model-map-edit
else
    echo -e "  ${YELLOW}⚠️  node not found — skipping JS helper symlinks${NC}"
fi
link_tool verify-llm-capabilities-mcp.sh verify-llm-capabilities-mcp

# --- Migrate legacy providers schema ---
# Guard: jq -e '.providers' is a no-op if key is absent — idempotent by design.
migrate_providers_schema() {
    local file="$1"
    [ -f "$file" ] || return 0
    jq -e '.providers' "$file" >/dev/null 2>&1 || return 0

    local timestamp
    timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup="${file}.bak.${timestamp}"
    cp "$file" "$backup"
    echo -e "  ${YELLOW}⚠️  Migrating legacy 'providers' schema${NC}"
    echo -e "  ${YELLOW}    Backup: ${backup}${NC}"

    local dropped
    dropped=$(jq -r '.providers | to_entries[] | select(.value | has("config_dir") or has("env") or (has("auth_token") and .auth_token != "ollama")) | .key' "$file" 2>/dev/null || true)
    if [ -n "$dropped" ]; then
        echo -e "  ${YELLOW}    Fields config_dir/env/auth_token cannot be auto-mapped; review these entries:${NC}"
        echo "$dropped" | while IFS= read -r k; do echo -e "  ${YELLOW}       - ${k}${NC}"; done
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
          ($prov | keys | map({key: ., value: .}) | from_entries) + (.model_routes // {})
        )
      } | del(.providers)
    ' "$file")
    tmp="${file}.tmp.$$"
    printf '%s\n' "$migrated" > "$tmp"
    mv "$tmp" "$file"

    local count
    count=$(printf '%s' "$migrated" | jq '.backends | length')
    echo -e "  ${GREEN}✅ Migrated ${count} provider(s) → backends + model_routes${NC}"
}

# --- User model-map: seed or validate ---
echo ""
echo "Model-map (${CLAUDE_DIR}/model-map.json):"
USER_MAP="$CLAUDE_DIR/model-map.json"
if [ -f "$USER_MAP" ]; then
    migrate_providers_schema "$USER_MAP"
    # Validate the existing map if the validator is available
    local_validate="$TOOLS_SRC/model-map-validate.js"
    if command -v node >/dev/null 2>&1 && [ -f "$local_validate" ]; then
        if node "$local_validate" "$USER_MAP" 2>/dev/null; then
            echo -e "  ${GRAY}✓  present and valid${NC}"
        else
            echo -e "  ${YELLOW}⚠️  present but validation failed — run: node ${local_validate} ${USER_MAP}${NC}"
        fi
    else
        echo -e "  ${GRAY}✓  present (validator not available)${NC}"
    fi
elif [ -f "$REPO_DIR/config/model-map.json" ]; then
    cp "$REPO_DIR/config/model-map.json" "$USER_MAP"
    echo -e "  ${GREEN}✅ Seeded from config/model-map.json${NC}"
else
    echo -e "  ${YELLOW}⚠️  No config/model-map.json found; skipping seed. Copy manually if needed.${NC}"
fi

echo ""
echo -e "${YELLOW}Quick reference:${NC}"
echo "  ~/.claude/tools/claude-router --list   list routes / local models"
echo "  ~/.claude/tools/model-map-validate     validate profile/project model-map configs"
echo "  tail ~/.claude/proxy.*.log             troubleshoot proxy startup"
echo "  pkill -f claude-proxy                  restart proxy after config edits"
echo "  CLAUDE_PROXY_BYPASS=1 claude ...       bypass proxy for direct Anthropic access"
echo ""
echo -e "${GREEN}✅ Done.${NC}"
