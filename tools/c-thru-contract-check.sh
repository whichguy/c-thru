#!/usr/bin/env bash
# c-thru-contract-check.sh
#
# Agent contract integrity checker for the c-thru agentic plan/wave system.
#
# Checks:
#   1.  Skill("review-plan") accidental invocation in skills/c-thru-plan/SKILL.md
#   1b. No hardcoded .c-thru/plans/ paths in agents/*.md
#   2.  Dangling subagent_type references (no corresponding agents/X.md file)
#   3.  Agent prompt key mismatches vs. declared Input: lines
#   4.  Agent-count consistency (agents/*.md vs agent_to_capability keys,
#       excluding routing-only entries that have no agent file)
#   5.  Phase 0 mkdir coverage for $PLAN_DIR subdirectories
#   6.  STATUS/VERDICT value coverage in SKILL.md + plan-orchestrator.md
#   7.  Undeclared prompt keys in Agent() invocations
#   8.  Restart-mode anchor presence in cloud agent files
#   9.  Tier-budget frontmatter declarations
#   10. preflight_model_readiness routing skeleton sync (tools/c-thru vs test wrapper)
#   11. LLM mode enum sync (model-map-resolve.js LLM_MODE_ENUM vs model-map-validate.js LLM_MODES)
#   12. benchmark.json schema + model_routes coverage (docs/benchmark.json)
#   13. Plan-section gap detection (docs/planning/*.md §N sequence continuity)
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
echo "1/13  Skill(\"review-plan\") regression..."
if grep -qE 'Skill\([[:space:]]*["'"'"']review-plan["'"'"']' "$SKILL" 2>/dev/null; then
    fail 'skills/c-thru-plan/SKILL.md: Skill("review-plan") found — must use Agent(subagent_type: "review-plan") here (Skill() path invokes the interactive human plan-mode tool, not the c-thru wave agent)'
else
    ok 'no Skill("review-plan") in SKILL.md'
fi

# ---------------------------------------------------------------------------
# Check 1b — No hardcoded .c-thru/plans/ paths in agents/*.md
# ---------------------------------------------------------------------------
echo "1b/13 Hardcoded .c-thru/plans/ in agents/*.md..."
hardcoded_agents=$(grep -l '\.c-thru/plans/' "$AGENTS_DIR"/*.md 2>/dev/null || true)
if [ -n "$hardcoded_agents" ]; then
    for f in $hardcoded_agents; do
        fail "$(basename "$f"): contains hardcoded .c-thru/plans/ path — agents must receive paths via prompt keys"
    done
else
    ok "no hardcoded .c-thru/plans/ in agents/*.md"
fi

# ---------------------------------------------------------------------------
# Check 2 — Dangling subagent_type references
# ---------------------------------------------------------------------------
echo "2/13  Dangling agent reference check..."

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
# For each Agent() block in SKILL.md + plan-orchestrator.md: extract key names
# from the prompt body. For each agent file: extract declared input tokens from
# the Input: line. Report: declared tokens with no corresponding key in prompt.
#
# Multi-mode agents: parse ## Mode N headings and match invocations by
# mode: N key (MODEKEY:<N> synthetic token from awk). Validate per-mode Input.
# Invocations without a mode: key → WARN (not FAIL).
#
# Fuzzy matching: single-word tokens (not compounds). Substring match on both
# sides. Accepts false negatives on compound names like journal_offset; the
# check catches obvious structural gaps (missing whole input categories).
# ---------------------------------------------------------------------------
echo "3/13  Agent prompt key check..."

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
    # Skip path-like examples: tokens containing $ / < > are not input key names
    while IFS= read -r tok; do
        case "$tok" in *'$'*|*/*|*'<'*|*'>'*) continue ;; esac
        echo "$tok"
    done < <(echo "$input_line" \
        | grep -oE '`[^`]+`' \
        | tr -d '`' \
        | sed 's/\.[a-z]*$//' \
        | tr '[:upper:]' '[:lower:]' \
        | tr '.-' '__')

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
                # Explicit *_out suffix: treat as declared input key regardless of stop-words
                case "$norm" in *_out) echo "$norm"; continue ;; esac

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
is_multi_mode() {
    local agent_file="$1"
    local count
    count=$(grep -c -Ei '^Input[s]?:' "$agent_file" 2>/dev/null || echo 0)
    [ "$count" -gt 1 ]
}

# Extract the Input: line for ## Mode N from an agent file.
mode_input_line() {
    local agent_file="$1" mode_n="$2"
    awk "/^## Mode ${mode_n}[[:space:]]/{found=1} found && /^Input[s]*:/{print; exit}" \
        "$agent_file" 2>/dev/null \
        | sed 's/^Input[s]*:[[:space:]]*//'
}

# agent_tokens_for_line: same logic as agent_tokens but takes an input string.
# Creates a temp file, runs agent_tokens against it.
agent_tokens_for_line() {
    local input_str="$1"
    local tmp
    tmp=$(mktemp)
    printf 'Input: %s\n' "$input_str" > "$tmp"
    agent_tokens "$tmp"
    rm -f "$tmp"
}

# Extract Agent(subagent_type: "X", prompt: "...") blocks from SKILL.md.
# Emits one line per block: AGENT_NAME|key1 key2 key3 ...
# BSD-awk-compatible state machine.
tmpblocks=$(mktemp)
trap 'rm -f "$tmpblocks"' EXIT

# awk_agent_blocks: extract Agent() blocks from a file.
# Emits: AGENT_NAME|key1 key2 ... MODEKEY:<N>
# MODEKEY:<N> is a synthetic token added when mode: N key is present in prompt.
awk_agent_blocks() {
awk '
BEGIN { agent=""; keys=""; in_prompt=0 }

/subagent_type:/ {
    if (agent != "" && in_prompt) { print agent "|" keys }
    agent=""; keys=""; in_prompt=0
    s=$0
    sub(/.*subagent_type:[[:space:]]*"/, "", s)
    sub(/".*/, "", s)
    if (s ~ /^</) { agent=""; next }
    agent=s
}

/[[:space:]]prompt:/ && agent != "" && !in_prompt {
    in_prompt=1
    s=$0
    sub(/.*prompt:[[:space:]]*"/, "", s)
    if (s ~ /^[a-zA-Z][a-zA-Z0-9_.-]+:/) {
        k=s; sub(/:.*/, "", k)
        keys=(keys == "" ? k : keys " " k)
        if (k == "mode") {
            val=s; sub(/^mode:[[:space:]]*/, "", val); gsub(/[^0-9].*/, "", val)
            if (val+0 > 0) keys=keys " MODEKEY:" val
        }
    }
    if ($0 ~ /"\)/) {
        print agent "|" keys
        agent=""; keys=""; in_prompt=0
    }
}

in_prompt && /^[[:space:]]+[a-zA-Z][a-zA-Z0-9_.-]+:[[:space:]]/ {
    s=$0
    gsub(/^[[:space:]]+/, "", s)
    sub(/:.*/, "", s)
    if (s != "" && s != "prompt") {
        keys=(keys == "" ? s : keys " " s)
    }
    if (s == "mode") {
        mline=$0; gsub(/^[[:space:]]+mode:[[:space:]]+/, "", mline); gsub(/[^0-9].*/, "", mline)
        if (mline+0 > 0) keys=keys " MODEKEY:" mline
    }
    if ($0 ~ /"\)/) {
        print agent "|" keys
        agent=""; keys=""; in_prompt=0
    }
}

in_prompt && /"\)/ && !/^[[:space:]]+[a-zA-Z][a-zA-Z0-9_.-]+:[[:space:]]/ && agent != "" {
    print agent "|" keys
    agent=""; keys=""; in_prompt=0
}
' "$1"
}

ORCHESTRATOR="$AGENTS_DIR/plan-orchestrator.md"
# Scan SKILL.md only for Check 3/7 (plan-orchestrator uses a different prompt-close
# format that the awk doesn't parse reliably). Check 6 uses grep directly.
awk_agent_blocks "$SKILL" > "$tmpblocks"

# For each extracted Agent() invocation, check prompt keys vs. declared inputs
while IFS='|' read -r agent keys; do
    [ -z "$agent" ] && continue
    agent_file="$AGENTS_DIR/${agent}.md"
    [ -f "$agent_file" ] || continue   # Already reported in check 2
    [ -z "$keys" ] && continue          # Path-only prompt (e.g. digest path) — skip

    # Multi-mode agents: match invocation to mode via MODEKEY:<N> synthetic token
    if is_multi_mode "$agent_file"; then
        mode_val=$(echo "$keys" | tr ' ' '\n' | { grep '^MODEKEY:' || true; } | sed 's/MODEKEY://' | head -1)
        if [ -z "$mode_val" ]; then
            warn "Agent(\"$agent\"): multi-mode invocation has no mode: key — cannot match to mode (prompt keys: $keys)"
            continue
        fi
        # Get Mode N Input line and validate against non-MODEKEY prompt keys
        input_line=$(mode_input_line "$agent_file" "$mode_val")
        if [ -z "$input_line" ]; then
            warn "Agent(\"$agent\"): mode: $mode_val invocation but no ## Mode $mode_val section in agent file"
            continue
        fi
        declared=$(agent_tokens_for_line "$input_line" | sort -u | tr '\n' ' ')
        [ -z "$declared" ] && continue
        # Keys without the synthetic MODEKEY marker
        real_keys=$(echo "$keys" | tr ' ' '\n' | { grep -v '^MODEKEY:' || true; } | tr '\n' ' ')
        norm_keys=$(echo "$real_keys" | tr '[:upper:]' '[:lower:]' | tr '.-' '__')
        for tok in $declared; do
            [ -z "$tok" ] && continue
            [ "${#tok}" -lt 3 ] && continue
            found=0
            for key in $norm_keys; do
                case "$key" in *"$tok"*) found=1; break ;; esac
                case "$tok" in *"$key"*) found=1; break ;; esac
            done
            if [ "$found" -eq 0 ]; then
                fail "Agent(\"$agent\") Mode $mode_val: declared input token \"$tok\" has no matching key in prompt (prompt keys: $real_keys)"
            fi
        done
        continue
    fi

    # Declared tokens for this agent (single-mode)
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
# Check 4 — Agent-count consistency
#
# Canonical source: config/model-map.json#agent_to_capability.
# agents/*.md count must match (minus routing-only keys); docs must not hardcode a different number.
# Routing-only keys: entries in agent_to_capability with no corresponding agent file
# (e.g. judge-evaluator — resolves via capability alias only, no agents/*.md).
# ---------------------------------------------------------------------------
echo "4/13  Agent-count consistency check..."

MODEL_MAP="$REPO_DIR/config/model-map.json"
if [ ! -f "$MODEL_MAP" ]; then
    warn "config/model-map.json not found — skipping Check 4"
else
    agent_file_count=$(ls "$AGENTS_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
    cap_key_count=$(jq '.agent_to_capability | keys | length' "$MODEL_MAP" 2>/dev/null || echo "0")
    # Count routing-only keys: agent_to_capability entries with no corresponding agent file
    routing_only_count=0
    for key in $(jq -r '.agent_to_capability | keys[]' "$MODEL_MAP" 2>/dev/null); do
        if [ ! -f "$AGENTS_DIR/${key}.md" ]; then
            routing_only_count=$((routing_only_count + 1))
        fi
    done
    effective_key_count=$((cap_key_count - routing_only_count))

    if [ "$agent_file_count" != "$effective_key_count" ]; then
        fail "agents/*.md count ($agent_file_count) != agent_to_capability keys ($cap_key_count, minus $routing_only_count routing-only = $effective_key_count) in config/model-map.json"
    else
        ok "agent count consistent: $agent_file_count agents/*.md = $effective_key_count agent_to_capability keys ($routing_only_count routing-only)"
    fi

    for doc in README.md CLAUDE.md docs/agent-architecture.md; do
        doc_path="$REPO_DIR/$doc"
        [ -f "$doc_path" ] || continue
        if grep -qE '\b[0-9]+[[:space:]]+(specialized[[:space:]]+)?(agents?|roles?)\b' "$doc_path" 2>/dev/null; then
            claimed=$(grep -oE '\b[0-9]+[[:space:]]+(specialized[[:space:]]+)?(agents?|roles?)\b' "$doc_path" \
                      | head -1 | grep -oE '^[0-9]+')
            if [ "$claimed" != "$agent_file_count" ]; then
                fail "$doc claims '$claimed agents/roles' but agents/ has $agent_file_count"
            else
                ok "$doc agent count ($claimed) matches agents/ ($agent_file_count)"
            fi
        fi
    done
fi

# ---------------------------------------------------------------------------
# Check 5 — Phase 0 mkdir coverage
#
# Every $PLAN_DIR/<subdir>/ referenced in SKILL.md must have a corresponding
# mkdir in Phase 0. Wave-scoped dirs ($wave_dir/...) are excluded.
# ---------------------------------------------------------------------------
echo "5/13  Phase 0 mkdir coverage check..."

# Extract subdirectory names referenced as $PLAN_DIR/<name>/ in SKILL.md
referenced=$(grep -oE '\$PLAN_DIR/[a-z_-]+/' "$SKILL" 2>/dev/null \
             | sed 's|\$PLAN_DIR/||;s|/$||' \
             | sort -u || true)

# Extract subdirectory names created in Phase 0 mkdir commands
phase0_mkdir=$(awk '/^## Phase 0/,/^## Phase 1/' "$SKILL" 2>/dev/null \
               | grep -oE '\$PLAN_DIR/[a-z_-]+' \
               | sed 's|\$PLAN_DIR/||' \
               | sort -u || true)

for d in $referenced; do
    # Skip file-like references (contain a dot) — these are files, not dirs
    case "$d" in *.*) continue ;; esac
    if ! echo "$phase0_mkdir" | grep -q "^${d}\$"; then
        fail "SKILL.md references \$PLAN_DIR/$d/ but Phase 0 mkdir does not create it"
    else
        ok "Phase 0 mkdir covers \$PLAN_DIR/$d/"
    fi
done

# ---------------------------------------------------------------------------
# Check 6 — STATUS/VERDICT value coverage
#
# For each agent called from SKILL.md or plan-orchestrator.md:
#   Extract declared STATUS/VERDICT values from the Return block.
#   For each non-trivial value V (not COMPLETE or APPROVED):
#     Search SKILL.md + plan-orchestrator.md for the literal string V as a
#     whole-word match. FAIL if the value is absent from both caller files.
# ---------------------------------------------------------------------------
echo "6/13  STATUS/VERDICT value coverage check..."

# Extract STATUS/VERDICT values from an agent's Return block.
# Matches both "**Return:**" (most agents) and "## Step N — Return STATUS"
# (plan-orchestrator) conventions. Prints one value per line.
extract_return_values() {
    local agent_file="$1"
    awk '
        /\*\*Return|\#\# Step [0-9].*Return/ { in_return=1; in_block=0; next }
        in_return && /^```/ { in_block = !in_block; next }
        in_return && in_block && /^STATUS:/ {
            line=$0; sub(/^STATUS:[[:space:]]*/, "", line)
            n=split(line, vals, /[|]/)
            for (i=1; i<=n; i++) { gsub(/[[:space:]]/, "", vals[i]); if (vals[i] != "") print vals[i] }
        }
        in_return && in_block && /^VERDICT:/ {
            line=$0; sub(/^VERDICT:[[:space:]]*/, "", line)
            n=split(line, vals, /[|]/)
            for (i=1; i<=n; i++) { gsub(/[[:space:]]/, "", vals[i]); if (vals[i] != "") print vals[i] }
        }
        in_return && !in_block && /^## / { in_return=0 }
    ' "$agent_file" 2>/dev/null
}

# Build list of agents referenced as subagent_type in SKILL.md or plan-orchestrator
called_agents=$(cut -d'|' -f1 "$tmpblocks" | sort -u)

for agent in $called_agents; do
    agent_file="$AGENTS_DIR/${agent}.md"
    [ -f "$agent_file" ] || continue
    while IFS= read -r val; do
        [ -z "$val" ] && continue
        # Skip always-ok values: COMPLETE and APPROVED are implicit success paths
        case "$val" in COMPLETE|APPROVED) ok "Agent(\"$agent\") $val — implicit success path"; continue ;; esac
        # Search both caller files for the literal value as a whole word
        found_in_callers=0
        for caller in "$SKILL" "$ORCHESTRATOR"; do
            [ -f "$caller" ] || continue
            if grep -qwE "$val" "$caller" 2>/dev/null; then
                found_in_callers=1
                break
            fi
        done
        if [ "$found_in_callers" -eq 1 ]; then
            ok "Agent(\"$agent\") $val — found in caller"
        else
            fail "Agent(\"$agent\"): declared return value \"$val\" has no branch in SKILL.md or plan-orchestrator.md"
        fi
    done < <(extract_return_values "$agent_file")
done

# ---------------------------------------------------------------------------
# Check 7 — Undeclared prompt keys in caller invocations
#
# For each single-mode Agent() block (multi-mode agents skipped):
#   Extract prompt keys. For each key K:
#     Check if any declared token T from agent_tokens satisfies substring match.
#     Also accept if K is in the built-in allowlist.
#   FAIL when a key is neither declared nor built-in.
#
# Allowlist: subagent_type, prompt, description, mode
# (model, run_in_background, timeout are agent-level params, not prompt-body keys)
# ---------------------------------------------------------------------------
echo "7/13  Undeclared prompt key check..."

# Built-in prompt keys never in an agent's Input: line
BUILTIN_PROMPT_KEYS="subagent_type prompt description mode"

while IFS='|' read -r agent keys; do
    [ -z "$agent" ] && continue
    agent_file="$AGENTS_DIR/${agent}.md"
    [ -f "$agent_file" ] || continue
    [ -z "$keys" ] && continue

    # Skip multi-mode agents (their optional keys can't be enumerated per invocation)
    if is_multi_mode "$agent_file"; then
        continue
    fi

    declared=$(agent_tokens "$agent_file" | sort -u | tr '\n' ' ')

    for key in $keys; do
        [ -z "$key" ] && continue
        # Normalize key
        norm_key=$(echo "$key" | tr '[:upper:]' '[:lower:]' | tr '.-' '__')
        [ "${#norm_key}" -lt 2 ] && continue

        # Check built-in allowlist
        in_builtin=0
        for b in $BUILTIN_PROMPT_KEYS; do
            [ "$norm_key" = "$b" ] && in_builtin=1 && break
        done
        [ "$in_builtin" -eq 1 ] && continue

        # Check against declared tokens (substring match, both directions)
        found=0
        for tok in $declared; do
            [ -z "$tok" ] && continue
            [ "${#tok}" -lt 3 ] && continue
            norm_tok=$(echo "$tok" | tr '[:upper:]' '[:lower:]' | tr '.-' '__')
            case "$norm_key" in *"$norm_tok"*) found=1; break ;; esac
            case "$norm_tok" in *"$norm_key"*) found=1; break ;; esac
        done
        if [ "$found" -eq 0 ]; then
            fail "Agent(\"$agent\"): prompt passes key \"$key\" but agent Input: does not declare it (declared: $declared)"
        fi
    done
done < "$tmpblocks"

# ---------------------------------------------------------------------------
# Check 8 — Restart-mode anchor presence in cloud agent files
#
# Static check: agents/implementer-cloud.md and agents/test-writer-cloud.md
# must contain a <!-- mode: restart --> anchor in their restart-mode branch.
# This anchor guards against anchoring-grep false positives from terms like
# "prior", "previous", or "attempt" bleeding into restart-mode sections.
# Runtime verification of rendered prompt digests belongs in the harness
# (test/c-thru-plan-harness.test.js), not here.
# Reference: wiki/entities/uplift-cascade-pattern.md
# ---------------------------------------------------------------------------
echo "8/13  Restart-mode anchor check in cloud agents..."

CLOUD_AGENTS=("$AGENTS_DIR/implementer-cloud.md" "$AGENTS_DIR/test-writer-cloud.md")
for cloud_agent in "${CLOUD_AGENTS[@]}"; do
    [ -f "$cloud_agent" ] || continue
    agent_base=$(basename "$cloud_agent")
    if ! grep -q '<!-- mode: restart -->' "$cloud_agent" 2>/dev/null; then
        fail "$agent_base: missing <!-- mode: restart --> anchor in restart-mode branch — add to the restart bullet in Mode detection section"
    else
        ok "$agent_base: <!-- mode: restart --> anchor present"
    fi
    # Anchoring-grep: verify no banned terms appear OUTSIDE a <!-- mode: restart --> anchor region.
    # Strategy: strip the restart-mode line (which legitimately describes the restart branch),
    # then check that no "prior approach" / "prior partial output" phrasing remains.
    stripped=$(grep -v '<!-- mode: restart -->' "$cloud_agent" 2>/dev/null || true)
    if echo "$stripped" | grep -qE 'prior (partial output|approach)'; then
        fail "$agent_base: contains 'prior partial output' or 'prior approach' outside restart-mode anchor — rephrase to avoid anchoring-grep false positive (use 'escalation input' or 'fresh approach')"
    else
        ok "$agent_base: no anchoring-grep false-positive terms outside restart-mode anchor"
    fi
done

# ---------------------------------------------------------------------------
# Check 9 — Tier-budget declarations + soft over-budget warning
#
# Every agents/*.md must declare tier_budget: N in frontmatter.
# WARNs (not FAILs) when estimated tokens (lines * 10) exceed 1.3 * declared budget.
# Estimation is approximate; per-agent calibration may adjust the 10-tokens/line factor.
# ---------------------------------------------------------------------------
echo "9/13  Tier-budget frontmatter check..."

BUDGET_WARNS=0
for agent_file in "$AGENTS_DIR"/*.md; do
    agent_base=$(basename "$agent_file")
    # Extract tier_budget from frontmatter (first ---...--- block)
    budget=$(awk '/^---/{fc++; if(fc==2) exit} fc==1 && /^tier_budget:/{print $2}' "$agent_file" 2>/dev/null || true)
    if [ -z "$budget" ]; then
        fail "$agent_base: missing tier_budget: field in frontmatter — add per D7"
        continue
    fi
    ok "$agent_base: tier_budget=$budget"
    # Soft over-budget check: lines * 10 vs 1.3 * budget
    line_count=$(wc -l < "$agent_file" | tr -d ' ')
    estimated_tokens=$((line_count * 10))
    threshold=$(echo "$budget * 1.3 / 1" | awk '{printf "%d", $1 * 1.3}' 2>/dev/null || echo $((budget * 13 / 10)))
    if [ "$estimated_tokens" -gt "$threshold" ]; then
        warn "$agent_base: estimated ~${estimated_tokens} tokens (${line_count} lines) exceeds 1.3× budget (budget=${budget}, threshold=${threshold})"
        BUDGET_WARNS=$((BUDGET_WARNS + 1))
    fi
done

if [ "$BUDGET_WARNS" -gt 0 ]; then
    echo -e "${YELLOW}  (${BUDGET_WARNS} over-budget agent(s) — warnings only, not failures)${NC}"
fi

# ---------------------------------------------------------------------------
# Check 10 — preflight_model_readiness routing skeleton sync
# The test wrapper (test/preflight-model-readiness.test.sh) copies the routing
# skeleton of preflight_model_readiness() from tools/c-thru, replacing only the
# pull/warm action block. This check diffs the shared skeleton up to the divergence
# sentinel line so any change to the routing logic is caught immediately.
# ---------------------------------------------------------------------------
echo "10/13 preflight_model_readiness routing skeleton sync..."

_canonical_skeleton=$(awk '
  /^preflight_model_readiness\(\)/ { in_fn=1 }
  in_fn && /grep -qxF/ { print; exit }
  in_fn { print }
' "$REPO_DIR/tools/c-thru")

_wrapper_skeleton=$(awk '
  /^preflight_model_readiness\(\)/ { in_fn=1 }
  in_fn && /grep -qxF/ { print; exit }
  in_fn { print }
' "$REPO_DIR/test/preflight-model-readiness.test.sh")

if [ -z "$_canonical_skeleton" ]; then
  fail "preflight_model_readiness not found in tools/c-thru"
elif [ -z "$_wrapper_skeleton" ]; then
  fail "preflight_model_readiness wrapper not found in test/preflight-model-readiness.test.sh"
elif [ "$_canonical_skeleton" != "$_wrapper_skeleton" ]; then
  fail "preflight_model_readiness routing skeleton has drifted — update wrapper in test/preflight-model-readiness.test.sh to match tools/c-thru"
else
  ok "preflight_model_readiness routing skeleton in sync"
fi
unset _canonical_skeleton _wrapper_skeleton

# ---------------------------------------------------------------------------
# Check 11 — LLM_MODE_ENUM / LLM_MODES sync
# Two files declare the set of valid mode names:
#   tools/model-map-resolve.js   → LLM_MODE_ENUM (used at request time)
#   tools/model-map-validate.js  → LLM_MODES   (used at config-validation time)
# These must stay in sync; an enum drift would cause a config that validates clean
# to be rejected at runtime (or vice versa).
# ---------------------------------------------------------------------------
echo "11/13 LLM mode enum sync (resolve.js vs validate.js)..."

# Extract sorted, deduplicated mode names from each file. Tolerant of either
# inline-array or multi-line set form.
_resolve_modes=$(node -e "
  const m = require('$REPO_DIR/tools/model-map-resolve.js');
  process.stdout.write([...m.LLM_MODE_ENUM].sort().join('\n'));
" 2>/dev/null || true)
_validate_modes=$(node -e "
  const fs = require('fs');
  const src = fs.readFileSync('$REPO_DIR/tools/model-map-validate.js', 'utf8');
  // LLM_MODES is internal — extract it via a regex match on the Set([...]) literal
  const m = src.match(/const LLM_MODES = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) { process.exit(2); }
  const items = [...m[1].matchAll(/'([^']+)'/g)].map(r => r[1]).sort();
  process.stdout.write(items.join('\n'));
" 2>/dev/null || true)

if [ -z "$_resolve_modes" ]; then
  fail "could not extract LLM_MODE_ENUM from tools/model-map-resolve.js"
elif [ -z "$_validate_modes" ]; then
  fail "could not extract LLM_MODES from tools/model-map-validate.js"
elif [ "$_resolve_modes" != "$_validate_modes" ]; then
  fail "LLM mode enum drift detected — model-map-resolve.js LLM_MODE_ENUM and model-map-validate.js LLM_MODES disagree"
  echo -e "${YELLOW}  resolve.js: $(echo "$_resolve_modes" | tr '\n' ' ')${NC}"
  echo -e "${YELLOW}  validate.js: $(echo "$_validate_modes" | tr '\n' ' ')${NC}"
else
  ok "LLM mode enum in sync ($(echo "$_resolve_modes" | wc -l | tr -d ' ') modes)"
fi
unset _resolve_modes _validate_modes

# ---------------------------------------------------------------------------
# Check 12 — benchmark.json schema + coverage
# Runs the benchmark validator to ensure docs/benchmark.json schema is valid
# and every model entry references a real model_routes key.
# Coverage warnings (model_routes entries missing from benchmark.json) are
# advisory and don't fail the contract check; schema errors do.
# ---------------------------------------------------------------------------
echo "12/13 benchmark.json schema + coverage..."

if [ ! -f "$REPO_DIR/docs/benchmark.json" ]; then
  warn "docs/benchmark.json not found — skipping benchmark validation"
elif [ ! -f "$REPO_DIR/tools/benchmark-validate.js" ]; then
  warn "tools/benchmark-validate.js not found — skipping benchmark validation"
else
  _bench_out=$(node "$REPO_DIR/tools/benchmark-validate.js" "$REPO_DIR/docs/benchmark.json" 2>&1)
  _bench_rc=$?
  if [ "$_bench_rc" -eq 0 ]; then
    ok "benchmark.json schema valid; model_routes coverage ok"
  else
    fail "benchmark.json schema validation failed:"
    echo "$_bench_out" | sed 's/^/        /'
  fi
  unset _bench_out _bench_rc
fi

# ---------------------------------------------------------------------------
# Check 13 — Plan-section gap detection
#
# Scans docs/planning/*.md for documents using §N section markers. For each
# file with 3 or more distinct §N integers, verifies the sequence is
# contiguous (no gaps). Ranges like §1-§3 or §1–§5 (en-dash) are expanded.
# Files with fewer than 3 markers are skipped as prose references.
# ---------------------------------------------------------------------------
echo "13/13 Plan-section gap detection (docs/planning/)..."

PLANNING_DIR="$REPO_DIR/docs/planning"
if [ ! -d "$PLANNING_DIR" ] || [ -z "$(ls "$PLANNING_DIR"/*.md 2>/dev/null)" ]; then
    ok "docs/planning/ absent or empty — skipping"
else
    for plan_file in "$PLANNING_DIR"/*.md; do
        plan_base=$(basename "$plan_file")

        # Collect all §N integers from the file.
        # Strategy:
        #   Pass 1: expand §N-§M and §N–§M ranges into individual integers
        #   Pass 2: extract bare §N markers
        # Combine, deduplicate, sort numerically.
        # All grep/tr calls use || true to avoid set -e exit on no-match.
        section_nums=$(
            # Expand range forms: §N-§M or §N–§M (hyphen or en-dash U+2013)
            { grep -oE '§[0-9]+-§[0-9]+|§[0-9]+[–-]§[0-9]+|§[0-9]+–[0-9]+|§[0-9]+-[0-9]+' "$plan_file" 2>/dev/null || true; } \
            | while IFS= read -r rng; do
                # Extract the two boundary integers regardless of separator form
                lo=$(echo "$rng" | { grep -oE '^§[0-9]+' || true; } | tr -d '§')
                hi=$(echo "$rng" | { grep -oE '[0-9]+$' || true; })
                if [ -n "$lo" ] && [ -n "$hi" ]; then
                    i=$lo
                    while [ "$i" -le "$hi" ]; do
                        echo "$i"
                        i=$((i + 1))
                    done
                fi
            done
            # Bare §N markers
            { grep -oE '§[0-9]+' "$plan_file" 2>/dev/null || true; } | tr -d '§'
        ) # end section_nums

        # Deduplicate and sort numerically; protect against empty input under set -e
        sorted=$(printf '%s\n' $section_nums | sort -nu | tr '\n' ' ' | sed 's/ $//')
        count=$(printf '%s\n' $section_nums | sort -nu | { grep -c '[0-9]' || true; })

        # Skip files with fewer than 3 distinct §N markers (prose refs, not structured plans)
        if [ "$count" -lt 3 ]; then
            ok "$plan_base: fewer than 3 §N markers ($count) — skipping gap check"
            continue
        fi

        # Skip files that don't contain §1 — structured plans always start at §1;
        # prose documents that cross-reference sections typically begin at §2 or higher
        # and are not enumerated plans.
        has_section_one=$(printf '%s\n' $section_nums | { grep -cxF '1' 2>/dev/null; true; })
        if [ "${has_section_one:-0}" -eq 0 ]; then
            ok "$plan_base: no §1 marker — treating as prose references, not a structured plan (skipping gap check)"
            continue
        fi

        # Check for gaps: build the expected contiguous sequence and diff
        min_n=$(echo "$sorted" | tr ' ' '\n' | head -1)
        max_n=$(echo "$sorted" | tr ' ' '\n' | tail -1)
        expected=$(seq "$min_n" "$max_n" | tr '\n' ' ' | sed 's/ $//')

        if [ "$sorted" = "$expected" ]; then
            ok "$plan_base: §$min_n–§$max_n contiguous ($count markers, no gaps)"
        else
            # Identify the missing integers
            missing=$(comm -23 \
                <(echo "$expected" | tr ' ' '\n' | sort -n) \
                <(echo "$sorted"   | tr ' ' '\n' | sort -n) \
                | tr '\n' ' ' | sed 's/ $//')
            fail "$plan_base: §N sequence gap(s) — missing: §$(echo "$missing" | sed 's/ /, §/g') (found: §$(echo "$sorted" | sed 's/ /, §/g'))"
        fi
    done
fi

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
