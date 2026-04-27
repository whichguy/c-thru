#!/usr/bin/env bash
# c-thru uninstaller: reverses the actions of install.sh.
#
# What this removes:
#   - Symlinks under ~/.claude/tools/ that point back into THIS repo
#   - ~/.claude/model-map.json (derived) and ~/.claude/model-map.system.json (install copy)
#   - c-thru hook entries from ~/.claude/settings.json (preserves user-added hooks)
#   - llm-capabilities entry from ~/.claude.json mcpServers (if present)
#   - Skill/command files install.sh creates (c-thru-status.md, cplan.md)
#   - Cache/state files (proxy.pid, proxy.log, usage-stats.json, prepull stamps, etc.)
#   - Stops any running claude-proxy first (TERM, then KILL after 2s)
#
# What this PRESERVES:
#   - ~/.claude/model-map.overrides.json (user data)
#   - Any unrelated symlinks or files in ~/.claude/
#
# Flags:
#   --dry-run | -n     : print what would be removed; do nothing
#   --yes     | -y     : skip the confirmation prompt
#   --purge-models     : ALSO delete Ollama models that c-thru pulled (opt-in)
#   --help    | -h     : show this help

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
TOOLS_DEST="$CLAUDE_DIR/tools"
TMPDIR_EFF="${TMPDIR:-/tmp}"

DRY_RUN=0
ASSUME_YES=0
PURGE_MODELS=0

COUNT_REMOVED=0
COUNT_SKIPPED=0
COUNT_PRESERVED=0

usage() {
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run|-n)   DRY_RUN=1; shift ;;
        --yes|-y)       ASSUME_YES=1; shift ;;
        --purge-models) PURGE_MODELS=1; shift ;;
        --help|-h)      usage; exit 0 ;;
        *) echo -e "${RED}Unknown flag: $1${NC}" >&2; usage >&2; exit 2 ;;
    esac
done

# ---- Helpers ----------------------------------------------------------------

say_remove() {
    if [ "$DRY_RUN" -eq 1 ]; then
        echo -e "  ${YELLOW}[dry-run] would remove${NC} $1"
    else
        echo -e "  ${GREEN}[ok] removed${NC} $1"
    fi
    COUNT_REMOVED=$((COUNT_REMOVED + 1))
}

say_skip() {
    echo -e "  ${GRAY}[skip]${NC} $1"
    COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
}

say_preserve() {
    echo -e "  ${GREEN}[preserve]${NC} $1"
    COUNT_PRESERVED=$((COUNT_PRESERVED + 1))
}

run_rm() {
    [ "$DRY_RUN" -eq 1 ] && return 0
    rm -f "$1" 2>/dev/null || true
}

# Detect whether a symlink under TOOLS_DEST resolves into our repo.
link_targets_repo() {
    local link="$1"
    local target
    target="$(readlink "$link" 2>/dev/null || true)"
    [ -z "$target" ] && return 1
    case "$target" in
        /*) ;;
        *)  target="$(dirname "$link")/$target" ;;
    esac
    local dir base canon
    dir="$(dirname "$target")"
    base="$(basename "$target")"
    canon="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
    canon="$canon/$base"
    case "$canon/" in
        "$REPO_DIR/"*) return 0 ;;
        *) return 1 ;;
    esac
}

# ---- Plan: enumerate everything ---------------------------------------------

PROXY_PIDS=()
PROXY_PID_FILE="$CLAUDE_DIR/proxy.pid"
if [ -f "$PROXY_PID_FILE" ]; then
    pid="$(cat "$PROXY_PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        PROXY_PIDS+=("$pid")
    fi
fi
if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r p; do
        [ -z "$p" ] && continue
        already=0
        if [ "${#PROXY_PIDS[@]}" -gt 0 ]; then
            for existing in "${PROXY_PIDS[@]}"; do
                [ "$existing" = "$p" ] && already=1 && break
            done
        fi
        [ "$already" -eq 0 ] && PROXY_PIDS+=("$p")
    done < <(pgrep -f 'claude-proxy' 2>/dev/null || true)
fi

LINKS_TO_REMOVE=()
LINKS_TO_KEEP=()
if [ -d "$TOOLS_DEST" ]; then
    while IFS= read -r -d '' link; do
        if [ -L "$link" ]; then
            if link_targets_repo "$link"; then
                LINKS_TO_REMOVE+=("$link")
            else
                LINKS_TO_KEEP+=("$link")
            fi
        fi
    done < <(find "$TOOLS_DEST" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
fi

FILES_TO_REMOVE=(
    "$CLAUDE_DIR/proxy.pid"
    "$CLAUDE_DIR/proxy.log"
    "$CLAUDE_DIR/usage-stats.json"
    "$CLAUDE_DIR/proxy-usage-stats.json"
    "$CLAUDE_DIR/ollama-prep-state.json"
    "$CLAUDE_DIR/c-thru-ollama-models.json"
)

SKILL_FILES=(
    "$CLAUDE_DIR/commands/c-thru-status.md"
    "$CLAUDE_DIR/commands/cplan.md"
)

SKILLS_CTHRU_DIR="$CLAUDE_DIR/skills/c-thru"
AGENTS_CTHRU_DIR="$CLAUDE_DIR/agents/c-thru"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# ---- Plan summary -----------------------------------------------------------

echo -e "${YELLOW}c-thru uninstaller — ${REPO_DIR}${NC}"
echo -e "${GRAY}profile dir: ${CLAUDE_DIR}${NC}"
[ "$DRY_RUN" -eq 1 ] && echo -e "${YELLOW}*** DRY-RUN MODE — nothing will be modified ***${NC}"
echo

echo "Plan:"
if [ "${#PROXY_PIDS[@]}" -gt 0 ]; then
    echo "  - stop ${#PROXY_PIDS[@]} running claude-proxy process(es): ${PROXY_PIDS[*]}"
else
    echo "  - no running claude-proxy processes"
fi
echo "  - remove ${#LINKS_TO_REMOVE[@]} repo-pointing symlink(s) under $TOOLS_DEST"
[ "${#LINKS_TO_KEEP[@]}" -gt 0 ] && \
    echo "  - keep ${#LINKS_TO_KEEP[@]} unrelated symlink(s) under $TOOLS_DEST"
echo "  - remove derived files (model-map.json, model-map.system.json)"
echo "  - PRESERVE model-map.overrides.json (user data)"
echo "  - clean c-thru hook entries from settings.json (preserve user hooks)"
echo "  - remove cache/state files (proxy.pid, proxy.log, stamps, etc.)"
[ "$PURGE_MODELS" -eq 1 ] && echo "  - PURGE Ollama models pulled by c-thru (--purge-models)"
echo

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    printf "Proceed? [y/N] "
    if [ -r /dev/tty ]; then
        read -r reply </dev/tty || reply=""
    else
        read -r reply || reply=""
    fi
    case "${reply:-}" in
        y|Y|yes|YES) ;;
        *) echo "Aborted."; exit 1 ;;
    esac
fi

# ---- Step 1: stop proxy -----------------------------------------------------

echo
echo "Stopping proxy:"
if [ "${#PROXY_PIDS[@]}" -eq 0 ]; then
    say_skip "no claude-proxy running"
else
    for pid in "${PROXY_PIDS[@]}"; do
        if [ "$DRY_RUN" -eq 1 ]; then
            echo -e "  ${YELLOW}[dry-run] would TERM${NC} pid $pid (KILL after 2s if alive)"
            COUNT_REMOVED=$((COUNT_REMOVED + 1))
            continue
        fi
        if kill -TERM "$pid" 2>/dev/null; then
            for _ in 1 2 3 4; do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.5
            done
            if kill -0 "$pid" 2>/dev/null; then
                kill -KILL "$pid" 2>/dev/null || true
                echo -e "  ${GREEN}[ok]${NC} killed pid $pid (after TERM timeout)"
            else
                echo -e "  ${GREEN}[ok]${NC} stopped pid $pid"
            fi
            COUNT_REMOVED=$((COUNT_REMOVED + 1))
        else
            say_skip "pid $pid already gone"
        fi
    done
fi

# ---- Step 2: remove repo-pointing symlinks ----------------------------------

echo
echo "Tool symlinks:"
if [ "${#LINKS_TO_REMOVE[@]}" -eq 0 ]; then
    say_skip "no repo-pointing symlinks under $TOOLS_DEST"
else
    for link in "${LINKS_TO_REMOVE[@]}"; do
        run_rm "$link"
        say_remove "$link"
    done
fi
if [ "${#LINKS_TO_KEEP[@]}" -gt 0 ]; then
    for keep in "${LINKS_TO_KEEP[@]}"; do
        say_preserve "$keep (target outside repo)"
    done
fi
# Remove TOOLS_DEST if now empty
if [ -d "$TOOLS_DEST" ] && [ -z "$(ls -A "$TOOLS_DEST" 2>/dev/null)" ]; then
    [ "$DRY_RUN" -eq 0 ] && rmdir "$TOOLS_DEST" 2>/dev/null || true
fi

# ---- Step 3: model-map files ------------------------------------------------

echo
echo "Model-map files:"
for f in "$CLAUDE_DIR/model-map.json" "$CLAUDE_DIR/model-map.system.json"; do
    if [ -e "$f" ]; then
        run_rm "$f"
        say_remove "$f"
    else
        say_skip "$f (not present)"
    fi
done
if [ -e "$CLAUDE_DIR/model-map.overrides.json" ]; then
    say_preserve "$CLAUDE_DIR/model-map.overrides.json (user data)"
else
    say_skip "$CLAUDE_DIR/model-map.overrides.json (not present)"
fi

# ---- Step 4: settings.json hook scrub --------------------------------------

echo
echo "settings.json hooks:"
if [ ! -f "$SETTINGS_FILE" ]; then
    say_skip "$SETTINGS_FILE (not present)"
else
    if ! command -v jq >/dev/null 2>&1; then
        echo -e "  ${RED}[error] jq not found — required to safely edit settings.json.${NC}" >&2
        echo -e "  ${RED}        Install with: brew install jq${NC}" >&2
        exit 3
    fi
    hook_regex='c-thru-|claude-proxy|llm-capabilities-mcp'
    if jq -e '.hooks // empty' "$SETTINGS_FILE" >/dev/null 2>&1; then
        before_count=$(jq --arg re "$hook_regex" '
            [.hooks // {} | to_entries[] | .value[]? | .hooks[]? |
             select((.command // "") | test($re))] | length
        ' "$SETTINGS_FILE" 2>/dev/null || echo 0)
        if [ "${before_count:-0}" -gt 0 ]; then
            if [ "$DRY_RUN" -eq 1 ]; then
                echo -e "  ${YELLOW}[dry-run] would remove ${before_count} c-thru hook entr(y/ies) from settings.json${NC}"
                COUNT_REMOVED=$((COUNT_REMOVED + before_count))
            else
                tmp="${SETTINGS_FILE}.tmp.$$"
                jq --arg re "$hook_regex" '
                    if .hooks then
                      .hooks |= with_entries(
                        .value |= map(
                          .hooks |= map(select((.command // "") | test($re) | not))
                        ) | map(select(.hooks | length > 0))
                      ) | .hooks |= with_entries(select(.value | length > 0))
                      | (if (.hooks | length) == 0 then del(.hooks) else . end)
                    else . end
                ' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
                echo -e "  ${GREEN}[ok] removed ${before_count} c-thru hook entr(y/ies) from settings.json${NC}"
                COUNT_REMOVED=$((COUNT_REMOVED + before_count))
            fi
        else
            say_skip "no c-thru hook entries found in settings.json"
        fi
    else
        say_skip "no .hooks key in settings.json"
    fi
    # Also scrub any leftover llm-capabilities MCP from ~/.claude.json
    claude_json="$HOME/.claude.json"
    if [ -f "$claude_json" ]; then
        if jq -e '.mcpServers["llm-capabilities"] // empty' "$claude_json" >/dev/null 2>&1; then
            if [ "$DRY_RUN" -eq 1 ]; then
                echo -e "  ${YELLOW}[dry-run] would remove llm-capabilities MCP from $claude_json${NC}"
                COUNT_REMOVED=$((COUNT_REMOVED + 1))
            else
                tmp="${claude_json}.tmp.$$"
                jq 'if .mcpServers then del(.mcpServers["llm-capabilities"]) else . end' "$claude_json" > "$tmp" && mv "$tmp" "$claude_json"
                echo -e "  ${GREEN}[ok]${NC} removed llm-capabilities MCP from $claude_json"
                COUNT_REMOVED=$((COUNT_REMOVED + 1))
            fi
        fi
    fi
fi

# ---- Step 5: skill / command files & directories --------------------------

echo
echo "Skill/command files:"
for f in "${SKILL_FILES[@]}"; do
    if [ -e "$f" ]; then
        if grep -q "c-thru" "$f" 2>/dev/null; then
            run_rm "$f"
            say_remove "$f"
        else
            say_preserve "$f (does not look like a c-thru-installed file)"
        fi
    else
        say_skip "$f (not present)"
    fi
done
# Remove ~/.claude/skills/c-thru and ~/.claude/agents/c-thru if they contain
# only symlinks pointing into this repo (or are already empty).
for cleanup_dir in "$SKILLS_CTHRU_DIR" "$AGENTS_CTHRU_DIR"; do
    if [ ! -d "$cleanup_dir" ]; then
        say_skip "$cleanup_dir (not present)"
        continue
    fi
    safe=1
    while IFS= read -r -d '' entry; do
        if [ -L "$entry" ]; then
            if ! link_targets_repo "$entry"; then
                safe=0
                break
            fi
        else
            safe=0
            break
        fi
    done < <(find "$cleanup_dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
    if [ "$safe" -eq 1 ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
            echo -e "  ${YELLOW}[dry-run] would remove${NC} $cleanup_dir (only repo-symlinks inside)"
            COUNT_REMOVED=$((COUNT_REMOVED + 1))
        else
            rm -rf "$cleanup_dir"
            say_remove "$cleanup_dir"
        fi
    else
        say_preserve "$cleanup_dir (contains user files / non-repo symlinks)"
    fi
done

# ---- Step 6: cache / state files ------------------------------------------

echo
echo "Cache/state files:"
for f in "${FILES_TO_REMOVE[@]}"; do
    if [ -e "$f" ]; then
        run_rm "$f"
        say_remove "$f"
    else
        say_skip "$f (not present)"
    fi
done

shopt -s nullglob
for pat in \
    "$CLAUDE_DIR"/.prepull-stamp-* \
    "$CLAUDE_DIR"/proxy.stderr.*.tmp \
    "$TMPDIR_EFF"/c-thru-effective-*.json \
; do
    [ -e "$pat" ] || continue
    run_rm "$pat"
    say_remove "$pat"
done
shopt -u nullglob

# ---- Step 7: optional Ollama model purge ----------------------------------

if [ "$PURGE_MODELS" -eq 1 ]; then
    echo
    echo "Ollama models (--purge-models):"
    gc_cmd=""
    if [ -x "$TOOLS_DEST/c-thru-ollama-gc" ]; then
        gc_cmd="$TOOLS_DEST/c-thru-ollama-gc"
    elif [ -x "$REPO_DIR/tools/c-thru-ollama-gc.sh" ]; then
        gc_cmd="$REPO_DIR/tools/c-thru-ollama-gc.sh"
    fi
    if [ -z "$gc_cmd" ]; then
        say_skip "c-thru-ollama-gc not found — cannot purge"
    else
        if [ "$DRY_RUN" -eq 1 ]; then
            echo -e "  ${YELLOW}[dry-run] would run${NC} $gc_cmd purge"
            COUNT_REMOVED=$((COUNT_REMOVED + 1))
        else
            "$gc_cmd" purge || echo -e "  ${YELLOW}[warn] $gc_cmd purge returned non-zero${NC}"
            echo -e "  ${GREEN}[ok]${NC} ran $gc_cmd purge"
            COUNT_REMOVED=$((COUNT_REMOVED + 1))
        fi
    fi
fi

# ---- Final summary ---------------------------------------------------------

echo
echo -e "${GREEN}Summary:${NC} removed=$COUNT_REMOVED  preserved=$COUNT_PRESERVED  skipped=$COUNT_SKIPPED"
echo
if [ -e "$CLAUDE_DIR/model-map.overrides.json" ]; then
    echo -e "${GREEN}Your overrides at $CLAUDE_DIR/model-map.overrides.json preserved.${NC}"
fi
echo
echo "To remove the repo itself:"
echo "    rm -rf \"$REPO_DIR\""
echo
[ "$DRY_RUN" -eq 1 ] && echo -e "${YELLOW}(dry-run — no changes were made)${NC}"
exit 0
