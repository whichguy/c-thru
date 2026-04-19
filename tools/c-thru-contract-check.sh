#!/usr/bin/env bash
# c-thru-contract-check.sh
#
# Agent contract integrity checker for the c-thru agentic plan/wave system.
#
# Checks:
#   1. Skill("review-plan") accidental invocation in skills/c-thru-plan/SKILL.md
#   2. Dangling subagent_type references (no corresponding agents/X.md file)
#   3. Agent prompt key mismatches vs. declared Input: lines
#
# Exit 0: no issues. Exit 1: one or more issues found.
# Run: bash tools/c-thru-contract-check.sh
# Symlinked by install.sh to ~/.claude/tools/c-thru-contract-check

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$REPO_DIR/skills/c-thru-plan/SKILL.md"
AGENTS_DIR="$REPO_DIR/agents"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
NC='\033[0m'

ISSUES=0

fail() { echo -e "${RED}FAIL${NC}  $*"; ISSUES=$((ISSUES + 1)); }
warn() { echo -e "${YELLOW}WARN${NC}  $*"; }
ok()   { echo -e "${GRAY}ok${NC}    $*"; }

if [ ! -f "$SKILL" ]; then
    echo -e "${RED}ERROR${NC}: SKILL.md not found at $SKILL" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Check 1 — Skill("review-plan") regression
# ---------------------------------------------------------------------------
echo "1/3  Skill(\"review-plan\") regression..."
if grep -qE 'Skill\([[:space:]]*["'"'"']review-plan["'"'"']' "$SKILL" 2>/dev/null; then
    fail 'skills/c-thru-plan/SKILL.md: Skill("review-plan") found — must use Agent(subagent_type: "review-plan") here (Skill() path invokes the interactive human plan-mode tool, not the c-thru wave agent)'
else
    ok 'no Skill("review-plan") in SKILL.md'
fi

# ---------------------------------------------------------------------------
# Check 2 — Dangling subagent_type references
# ---------------------------------------------------------------------------
echo "2/3  Dangling agent reference check..."

# Claude Code built-in subagent types — no agents/*.md expected for these
BUILTIN="general-purpose Explore"

while IFS= read -r agent; do
    [ -z "$agent" ] && continue
    # Skip template placeholders like <agent-name>
    [[ "$agent" == \<* ]] && continue
    is_builtin=0
    for b in $BUILTIN; do
        [ "$agent" = "$b" ] && is_builtin=1 && break
    done
    if [ "$is_builtin" -eq 1 ]; then
        ok "subagent_type \"$agent\" is a Claude Code built-in (allowlisted)"
        continue
    fi
    if [ ! -f "$AGENTS_DIR/${agent}.md" ]; then
        fail "subagent_type: \"$agent\" referenced in SKILL.md but agents/${agent}.md does not exist"
    else
        ok "agents/${agent}.md exists"
    fi
done < <(grep -oE 'subagent_type:[[:space:]]*"[^"]+"' "$SKILL" \
         | grep -oE '"[^"]+"' \
         | tr -d '"' \
         | sort -u)

# ---------------------------------------------------------------------------
# Check 3 — Agent prompt key mismatch
#
# For each Agent() block in SKILL.md: extract key names from the prompt body.
# For each agent file: extract declared input tokens from the Input: line.
# Report: declared tokens with no corresponding key in the prompt.
#
# Fuzzy matching: single-word tokens (not compounds). Substring match on both
# sides. Accepts false negatives on compound names like journal_offset; the
# check catches obvious structural gaps (missing whole input categories).
# ---------------------------------------------------------------------------
echo "3/3  Agent prompt key check..."

# Returns newline-separated input tokens for an agent file.
# Strategy:
#   a. Backtick-quoted terms (most precise) — strip file extension, normalize
#   b. Strip all backtick content from the line, split on +, extract each
#      meaningful word individually (filtered stop-word list)
agent_tokens() {
    local agent_file="$1"
    local input_line
    input_line=$(grep -m1 -Ei '^Input[s]?:' "$agent_file" 2>/dev/null \
                 | sed 's/^Input[s]*:[[:space:]]*//' || true)
    [ -z "$input_line" ] && return

    # a. Backtick-quoted tokens — strip file extension, normalize to snake_case
    echo "$input_line" \
        | grep -oE '`[^`]+`' \
        | tr -d '`' \
        | sed 's/\.[a-z]*$//' \
        | tr '[:upper:]' '[:lower:]' \
        | tr '.-' '__'

    # b. Strip backtick content, then extract individual meaningful words
    local stripped
    stripped=$(echo "$input_line" | sed 's/`[^`]*`//g')
    echo "$stripped" \
        | tr '+' '\n' \
        | sed 's/^ *//' \
        | while IFS= read -r seg; do
            # Strip trailing punctuation and parenthetical notes
            seg=$(echo "$seg" | sed 's/[.(].*$//' | sed 's/[[:space:]]*$//')
            # Emit each word as a separate token
            for word in $seg; do
                norm=$(echo "$word" | tr '[:upper:]' '[:lower:]' | tr '.-' '__')
                # Broad stop-word list for prose input descriptions.
                # These are modifier/descriptor words; the semantic key is a
                # sibling word in the same phrase (e.g. "plan INDEX path" → key
                # is INDEX, not "plan"; "original intent string" → key is intent).
                case "$norm" in
                    ''|a|an|the|or|and|list|of|string|number|read|it|follow) continue ;;
                    path|paths|file|may|be|empty|prior|wave|existing|raw|full) continue ;;
                    current|plain|its|for|this|that|line|primary|secondary) continue ;;
                    only|original|plan|do|not|write|any|files|stage) continue ;;
                esac
                [ "${#norm}" -lt 3 ] && continue
                echo "$norm"
            done
          done
}

# Detect multi-mode agents (multiple Inputs:/Input: sections).
# These have mode-specific inputs; a single invocation will not cover all
# declared inputs. Return 1 if multi-mode, 0 otherwise.
is_multi_mode() {
    local agent_file="$1"
    local count
    count=$(grep -c -Ei '^Input[s]?:' "$agent_file" 2>/dev/null || echo 0)
    [ "$count" -gt 1 ]
}

# Extract Agent(subagent_type: "X", prompt: "...") blocks from SKILL.md.
# Emits one line per block: AGENT_NAME|key1 key2 key3 ...
# BSD-awk-compatible state machine.
tmpblocks=$(mktemp)
trap 'rm -f "$tmpblocks"' EXIT

awk '
BEGIN { agent=""; keys=""; in_prompt=0 }

# Start of a new Agent block
/subagent_type:/ {
    if (agent != "" && in_prompt) { print agent "|" keys }
    agent=""; keys=""; in_prompt=0
    s=$0
    sub(/.*subagent_type:[[:space:]]*"/, "", s)
    sub(/".*/, "", s)
    # Skip template placeholders
    if (s ~ /^</) { agent=""; next }
    agent=s
}

# prompt: line — mark start; may have a key on the same line after the quote
/[[:space:]]prompt:/ && agent != "" && !in_prompt {
    in_prompt=1
    s=$0
    sub(/.*prompt:[[:space:]]*"/, "", s)
    # A key starts the prompt content right after the opening quote
    if (s ~ /^[a-zA-Z][a-zA-Z0-9_.]+:/) {
        k=s; sub(/:.*/, "", k)
        keys=(keys == "" ? k : keys " " k)
    }
    # Single-line prompt (opens and closes on this line)
    if ($0 ~ /"\)/) {
        print agent "|" keys
        agent=""; keys=""; in_prompt=0
    }
}

# Key-value lines in the prompt body
in_prompt && /^[[:space:]]+[a-zA-Z][a-zA-Z0-9_.]+:[[:space:]]/ {
    s=$0
    gsub(/^[[:space:]]+/, "", s)
    sub(/:.*/, "", s)
    if (s != "" && s != "prompt") {
        keys=(keys == "" ? s : keys " " s)
    }
    # Closing line: ends with ")
    if ($0 ~ /"\)/) {
        print agent "|" keys
        agent=""; keys=""; in_prompt=0
    }
}

# Closing line without a key (just ends with ")
in_prompt && /"\)/ && !/^[[:space:]]+[a-zA-Z][a-zA-Z0-9_.]+:[[:space:]]/ && agent != "" {
    print agent "|" keys
    agent=""; keys=""; in_prompt=0
}
' "$SKILL" > "$tmpblocks"

# For each extracted Agent() invocation, check prompt keys vs. declared inputs
while IFS='|' read -r agent keys; do
    [ -z "$agent" ] && continue
    agent_file="$AGENTS_DIR/${agent}.md"
    [ -f "$agent_file" ] || continue   # Already reported in check 2
    [ -z "$keys" ] && continue          # Path-only prompt (e.g. digest path) — skip

    # Multi-mode agents: skip key check; their inputs vary per-mode invocation
    if is_multi_mode "$agent_file"; then
        warn "Agent(\"$agent\"): multi-mode — key check skipped (mode-specific inputs)"
        continue
    fi

    # Declared tokens for this agent
    declared=$(agent_tokens "$agent_file" | sort -u | tr '\n' ' ')
    [ -z "$declared" ] && continue

    # Normalize prompt keys for substring comparison
    norm_keys=$(echo "$keys" | tr '[:upper:]' '[:lower:]' | tr '.-' '__')

    for tok in $declared; do
        [ -z "$tok" ] && continue
        [ "${#tok}" -lt 3 ] && continue
        found=0
        for key in $norm_keys; do
            case "$key" in *"$tok"*) found=1; break ;; esac
            case "$tok" in *"$key"*) found=1; break ;; esac
        done
        if [ "$found" -eq 0 ]; then
            fail "Agent(\"$agent\"): declared input token \"$tok\" has no matching key in prompt (prompt keys: $keys)"
        fi
    done
done < "$tmpblocks"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$ISSUES" -eq 0 ]; then
    echo -e "${GREEN}✓ Contract check clean — 0 issues${NC}"
    exit 0
else
    echo -e "${RED}✗ Contract check failed — ${ISSUES} issue(s)${NC}"
    exit 1
fi
