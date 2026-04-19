#!/usr/bin/env bash
# c-thru uninstaller: removes agentic plan/wave system artifacts installed by install.sh.
# Safe to re-run: treats missing artifacts as no-ops.
# Does NOT remove: claude-router, claude-proxy, hooks, original 5 capability aliases,
#   model-map.overrides.json (user data), or .c-thru/plans/ project state.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
TOOLS_SRC="$REPO_DIR/tools"

JQ_AVAILABLE=0
if command -v jq >/dev/null 2>&1; then
    JQ_AVAILABLE=1
fi

echo -e "${YELLOW}🔧 c-thru uninstaller — removing agentic plan/wave system${NC}"
echo ""

# --- Remove agent symlinks ---
# Removes only symlinks under ~/.claude/agents/c-thru/ that point into this repo.
# Never deletes real files or symlinks owned by other repos.
remove_agents() {
    local agents_dest="$CLAUDE_DIR/agents/c-thru"
    if [ ! -d "$agents_dest" ]; then
        echo -e "  ${GRAY}✓  agents/c-thru/ not present — nothing to remove${NC}"
        return 0
    fi

    local removed=0
    for dest in "$agents_dest"/*.md; do
        [ -e "$dest" ] || continue
        if [ -L "$dest" ]; then
            local target
            target="$(readlink "$dest")"
            if [[ "$target" == "$REPO_DIR/"* ]]; then
                rm "$dest"
                echo -e "  ${GREEN}✅ removed agents/c-thru/$(basename "$dest")${NC}"
                removed=$((removed + 1))
            else
                echo -e "  ${GRAY}✓  agents/c-thru/$(basename "$dest") — not owned by this repo, skipping${NC}"
            fi
        fi
    done

    # Remove directory if now empty
    if [ $removed -gt 0 ] && [ -z "$(ls -A "$agents_dest" 2>/dev/null)" ]; then
        rmdir "$agents_dest" 2>/dev/null || true
        echo -e "  ${GRAY}  (removed empty agents/c-thru/ directory)${NC}"
    fi
    [ $removed -gt 0 ] || echo -e "  ${GRAY}✓  no agent symlinks to remove${NC}"
}

# --- Remove skill symlinks ---
# Removes only symlinks under ~/.claude/skills/c-thru/ that point into this repo.
remove_skills_cthru() {
    local skills_dest="$CLAUDE_DIR/skills/c-thru"
    if [ ! -d "$skills_dest" ]; then
        echo -e "  ${GRAY}✓  skills/c-thru/ not present — nothing to remove${NC}"
        return 0
    fi

    local removed=0
    for dest in "$skills_dest"/*/; do
        [ -e "$dest" ] || continue
        local name
        name="$(basename "$dest")"
        local link="${dest%/}"
        if [ -L "$link" ]; then
            local target
            target="$(readlink "$link")"
            if [[ "$target" == "$REPO_DIR/"* ]]; then
                rm "$link"
                echo -e "  ${GREEN}✅ removed skills/c-thru/${name}${NC}"
                removed=$((removed + 1))
            else
                echo -e "  ${GRAY}✓  skills/c-thru/${name} — not owned by this repo, skipping${NC}"
            fi
        fi
    done

    if [ $removed -gt 0 ] && [ -z "$(ls -A "$skills_dest" 2>/dev/null)" ]; then
        rmdir "$skills_dest" 2>/dev/null || true
        echo -e "  ${GRAY}  (removed empty skills/c-thru/ directory)${NC}"
    fi
    [ $removed -gt 0 ] || echo -e "  ${GRAY}✓  no skill symlinks to remove${NC}"
}

# --- Remove capability aliases from model-map.system.json ---
# Removes: judge, judge-strict, orchestrator, code-analyst, pattern-coder, deep-coder
#   from every llm_profiles tier, and removes agent_to_capability top-level key.
# Also removes the 6 new model_routes entries added by install.sh.
# Preserves: original 5 aliases (classifier, explorer, reviewer, workhorse, coder, default).
# Validates the result before atomic rename (config-swap-invariant).
# Failure mode: prints descriptive error, leaves system map untouched.
remove_model_map_aliases() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping model-map cleanup${NC}"
        return 0
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠️  node not found — skipping model-map cleanup${NC}"
        return 0
    fi

    local system_map="$CLAUDE_DIR/model-map.system.json"
    if [ ! -f "$system_map" ]; then
        echo -e "  ${GRAY}✓  model-map.system.json not present — nothing to remove${NC}"
        return 0
    fi

    local has_judge
    has_judge=$(jq -r '.llm_profiles["128gb"]["judge"] // empty' "$system_map" 2>/dev/null || true)
    if [ -z "$has_judge" ]; then
        echo -e "  ${GRAY}✓  capability aliases not present — nothing to remove${NC}"
        return 0
    fi

    local tmp="${system_map}.tmp.$$"
    jq '
        .llm_profiles = (
            .llm_profiles | to_entries | map(
                .value = (.value |
                    del(.["judge"], .["judge-strict"], .["orchestrator"],
                        .["code-analyst"], .["pattern-coder"], .["deep-coder"])
                )
            ) | from_entries
        ) |
        del(.agent_to_capability) |
        del(.model_routes["devstral-small:2"],
            .model_routes["qwen3.6:35b"],
            .model_routes["qwen3.5:122b"],
            .model_routes["qwen3.5:27b"],
            .model_routes["qwen3.5:9b"],
            .model_routes["qwen3.5:1.7b"])
    ' "$system_map" > "$tmp" || { echo -e "  ${RED}❌ jq transformation failed${NC}" >&2; rm -f "$tmp"; return 1; }

    local validate_rc=0 validate_out
    validate_out=$(node "$TOOLS_SRC/model-map-validate.js" "$tmp" 2>&1) || validate_rc=$?
    if [ "$validate_rc" -eq 0 ]; then
        mv "$tmp" "$system_map"
        echo -e "  ${GREEN}✅ removed capability aliases + agent_to_capability from model-map.system.json${NC}"
    else
        echo -e "  ${RED}❌ validation failed after removal — not writing${NC}" >&2
        echo "$validate_out" >&2
        rm -f "$tmp"
        return 1
    fi
}

echo "Agents:"
remove_agents

echo ""
echo "Skills:"
remove_skills_cthru

echo ""
echo "Model-map:"
remove_model_map_aliases

# Warn about preserved project state
if ls .c-thru/plans/ >/dev/null 2>&1; then
    echo ""
    echo -e "  ${YELLOW}ℹ️  .c-thru/plans/ project state preserved — remove manually if not needed${NC}"
fi

echo ""
echo -e "${GREEN}✅ Uninstall complete.${NC}"
echo -e "${GRAY}   claude-router, claude-proxy, hooks, and original 5 aliases were not touched.${NC}"
