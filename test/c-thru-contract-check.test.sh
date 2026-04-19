#!/usr/bin/env bash
# Tests for tools/c-thru-contract-check.sh
# 3 fixtures: missing-key → fail, dangling-agent → fail, clean → pass
#
# Run: bash test/c-thru-contract-check.test.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$REPO_DIR/tools/c-thru-contract-check.sh"

PASS=0
FAIL=0

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" -eq "$expected" ]; then
        echo "  PASS  $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL  $label (expected exit $expected, got $actual)"
        FAIL=$((FAIL + 1))
    fi
}

# ---------------------------------------------------------------------------
# Fixture helper — build a minimal SKILL.md + agents/ dir in a temp workspace
# ---------------------------------------------------------------------------
setup_workspace() {
    local dir
    dir=$(mktemp -d)
    mkdir -p "$dir/skills/c-thru-plan" "$dir/agents"
    echo "$dir"
}

teardown_workspace() {
    rm -rf "$1"
}

# Make a minimal agent file with one Input: line
write_agent() {
    local dir="$1" name="$2" input_line="$3"
    cat > "$dir/agents/${name}.md" <<EOF
---
name: $name
model: $name
---
# $name
Input: $input_line
EOF
}

# Make a SKILL.md with one Agent() block
write_skill() {
    local dir="$1" subagent_type="$2" prompt_body="$3"
    cat > "$dir/skills/c-thru-plan/SKILL.md" <<EOF
---
name: c-thru-plan
---
## Phase 1

\`\`\`
Agent(subagent_type: "$subagent_type",
  prompt: "$prompt_body")
\`\`\`
EOF
}

# Run checker against a synthetic workspace (override REPO_DIR + SKILL via env)
run_checker_in() {
    local dir="$1"
    # Patch the checker to use our synthetic workspace paths
    local patched="$dir/checker.sh"
    sed "s|REPO_DIR=.*|REPO_DIR=\"$dir\"|" "$CHECKER" > "$patched"
    sed -i.bak "s|SKILL=.*|SKILL=\"$dir/skills/c-thru-plan/SKILL.md\"|" "$patched"
    sed -i.bak "s|AGENTS_DIR=.*|AGENTS_DIR=\"$dir/agents\"|" "$patched"
    chmod +x "$patched"
    bash "$patched" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Fixture 1 — Dangling agent (subagent_type references missing agents/*.md)
# ---------------------------------------------------------------------------
echo "Fixture 1: dangling agent reference..."
F1=$(setup_workspace)
write_agent "$F1" "real-agent" "digest path."
write_skill "$F1" "ghost-agent" "digest: /tmp/c-thru/x/test-slug/digest.md"
# ghost-agent has no agents/ghost-agent.md
rc=0; run_checker_in "$F1" >/dev/null 2>&1 || rc=$?
check "dangling agent → exit 1" 1 "$rc"
teardown_workspace "$F1"

# ---------------------------------------------------------------------------
# Fixture 2 — Missing key (agent declares input not passed in prompt)
# ---------------------------------------------------------------------------
echo "Fixture 2: missing key in prompt..."
F2=$(setup_workspace)
# Agent declares "journal_offset" but prompt omits it
write_agent "$F2" "my-agent" "\`journal.md\` path + journal line offset."
# Prompt passes journal but NOT journal_offset
write_skill "$F2" "my-agent" "journal:  /tmp/c-thru/x/test-slug/journal.md"
rc=0; run_checker_in "$F2" >/dev/null 2>&1 || rc=$?
check "missing key (journal_offset) → exit 1" 1 "$rc"
teardown_workspace "$F2"

# ---------------------------------------------------------------------------
# Fixture 3 — Clean (agent exists, all declared inputs covered)
# ---------------------------------------------------------------------------
echo "Fixture 3: clean case..."
F3=$(setup_workspace)
write_agent "$F3" "clean-agent" "\`journal.md\` path + digest path."
write_skill "$F3" "clean-agent" "journal:  /tmp/c-thru/x/test-slug/journal.md
           digest:  /tmp/c-thru/x/test-slug/digests/item.md"
rc=0; run_checker_in "$F3" >/dev/null 2>&1 || rc=$?
check "clean case → exit 0" 0 "$rc"
teardown_workspace "$F3"

# ---------------------------------------------------------------------------
# Fixture 4 — Skill("review-plan") regression
# ---------------------------------------------------------------------------
echo "Fixture 4: Skill(\"review-plan\") regression..."
F4=$(setup_workspace)
write_agent "$F4" "review-plan" "current.md path + INDEX.md path + round number."
cat > "$F4/skills/c-thru-plan/SKILL.md" <<'EOF'
---
name: c-thru-plan
---
## Phase 3

Invoke the `review-plan` **agent** (not the skill) in a loop.

  result = Skill("review-plan")
EOF
rc=0; run_checker_in "$F4" >/dev/null 2>&1 || rc=$?
check "Skill(\"review-plan\") → exit 1" 1 "$rc"
teardown_workspace "$F4"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
