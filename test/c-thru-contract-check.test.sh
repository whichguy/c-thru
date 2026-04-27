#!/usr/bin/env bash
# Tests for tools/c-thru-contract-check.sh
# 12 fixtures: dangling-agent, missing-key, clean, Skill() regression, path-backtick FP,
#              *_out key missing, agent-count mismatch, Phase 0 mkdir missing,
#              multi-mode Mode 1 pass, undeclared key fail, multi-mode Mode 2 fail,
#              hyphenated key (replan-brief) pass
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
tier_budget: 50000
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
# Fixture 5 — Path-example in backticks is NOT a false positive
# Agent Input: line contains a backtick path like `$PLAN_DIR/waves/003` — the
# checker must skip it (not treat it as a required prompt key).
# ---------------------------------------------------------------------------
echo "Fixture 5: path-like backtick token not flagged as missing key..."
F5=$(setup_workspace)
mkdir -p "$F5/config"
cat > "$F5/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "path-agent": "pattern-coder" } }
EOF
write_agent "$F5" "path-agent" "\`journal.md\` path + digest path. e.g. \`\$PLAN_DIR/waves/003\`"
write_skill "$F5" "path-agent" "journal:  /tmp/c-thru/x/test-slug/journal.md
           digest:  /tmp/c-thru/x/test-slug/digests/item.md"
rc=0; run_checker_in "$F5" >/dev/null 2>&1 || rc=$?
check "path backtick example — no false positive → exit 0" 0 "$rc"
teardown_workspace "$F5"

# ---------------------------------------------------------------------------
# Fixture 6 — Declared *_out key missing in prompt → fail
# Agent Input: line includes gaps_out (ends in _out); prompt omits it.
# ---------------------------------------------------------------------------
echo "Fixture 6: declared *_out key missing in prompt → fail..."
F6=$(setup_workspace)
mkdir -p "$F6/config"
cat > "$F6/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "gap-agent": "pattern-coder" } }
EOF
write_agent "$F6" "gap-agent" "intent string + recon_path path + gaps_out path."
write_skill "$F6" "gap-agent" "intent:      some task
           recon_path:  /tmp/c-thru/x/test-slug/discovery/recon.md"
rc=0; run_checker_in "$F6" >/dev/null 2>&1 || rc=$?
check "missing *_out key (gaps_out) → exit 1" 1 "$rc"
teardown_workspace "$F6"

# ---------------------------------------------------------------------------
# Fixture 7 — Agent-count mismatch (agents/*.md != agent_to_capability keys)
# ---------------------------------------------------------------------------
echo "Fixture 7: agent count mismatch → fail..."
F7=$(setup_workspace)
mkdir -p "$F7/config"
# 3 agent files but model-map only has 2 agent_to_capability entries — count mismatch.
# (3 files vs 2 entries: agent-c has a file but no capability entry, so 3 ≠ 2.)
write_agent "$F7" "agent-a" "digest path."
write_agent "$F7" "agent-b" "digest path."
write_agent "$F7" "agent-c" "digest path."
cat > "$F7/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "agent-a": "pattern-coder", "agent-b": "pattern-coder" } }
EOF
write_skill "$F7" "agent-a" "digest: /tmp/c-thru/x/test-slug/digests/item.md"
rc=0; run_checker_in "$F7" >/dev/null 2>&1 || rc=$?
check "agent count mismatch → exit 1" 1 "$rc"
teardown_workspace "$F7"

# ---------------------------------------------------------------------------
# Fixture 8 — SKILL.md references $PLAN_DIR/reports/ but Phase 0 has no mkdir
# ---------------------------------------------------------------------------
echo "Fixture 8: missing Phase 0 mkdir for referenced subdir → fail..."
F8=$(setup_workspace)
mkdir -p "$F8/config"
write_agent "$F8" "report-agent" "digest path."
cat > "$F8/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "report-agent": "pattern-coder" } }
EOF
cat > "$F8/skills/c-thru-plan/SKILL.md" <<'EOF'
---
name: c-thru-plan
---
## Phase 0

mkdir -p $PLAN_DIR/waves $PLAN_DIR/discovery

## Phase 1

Write output to $PLAN_DIR/reports/summary.md.

```
Agent(subagent_type: "report-agent",
  prompt: "digest: /tmp/c-thru/x/test-slug/digests/item.md")
```
EOF
rc=0; run_checker_in "$F8" >/dev/null 2>&1 || rc=$?
check "Phase 0 missing mkdir for reports/ → exit 1" 1 "$rc"
teardown_workspace "$F8"

# ---------------------------------------------------------------------------
# Fixture 9 — Unhandled STATUS value: agent declares STATUS=CUSTOM_VALUE
# but caller SKILL.md has no branch for it → Check 6 must fail.
# ---------------------------------------------------------------------------
echo "Fixture 9: unhandled STATUS value → fail..."
F9=$(setup_workspace)
mkdir -p "$F9/config"
cat > "$F9/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "status-agent": "pattern-coder" } }
EOF
# Agent declares STATUS: COMPLETE|ERROR|CUSTOM_VALUE
cat > "$F9/agents/status-agent.md" <<'EOF'
---
name: status-agent
model: status-agent
tier_budget: 50000
---
# status-agent
Input: digest path.

**Return:**
```
STATUS: COMPLETE|ERROR|CUSTOM_VALUE
SUMMARY: <text>
```
EOF
# SKILL.md calls status-agent but only branches on COMPLETE and ERROR
cat > "$F9/skills/c-thru-plan/SKILL.md" <<'EOF'
---
name: c-thru-plan
---
## Phase 0

mkdir -p $PLAN_DIR/discovery $PLAN_DIR/waves $PLAN_DIR/plan $PLAN_DIR/review

## Phase 1

```
Agent(subagent_type: "status-agent",
  prompt: "digest: /tmp/c-thru/x/test-slug/digests/item.md")
```

if STATUS == "ERROR": abort
if STATUS == "COMPLETE": proceed
EOF
rc=0; run_checker_in "$F9" >/dev/null 2>&1 || rc=$?
check "unhandled STATUS value (CUSTOM_VALUE) → exit 1" 1 "$rc"
teardown_workspace "$F9"

# ---------------------------------------------------------------------------
# Fixture 10 — Undeclared prompt key: caller passes a key the agent doesn't
# declare in its Input: line → Check 7 must fail.
# ---------------------------------------------------------------------------
echo "Fixture 10: undeclared prompt key → fail..."
F10=$(setup_workspace)
mkdir -p "$F10/config"
cat > "$F10/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "keyed-agent": "pattern-coder" } }
EOF
# Agent declares only "digest path" — no undeclared_secret key
cat > "$F10/agents/keyed-agent.md" <<'EOF'
---
name: keyed-agent
model: keyed-agent
tier_budget: 50000
---
# keyed-agent
Input: `digest` path.

**Return:**
```
STATUS: COMPLETE|ERROR
```
EOF
# Caller passes "undeclared_secret" key not in agent's Input
cat > "$F10/skills/c-thru-plan/SKILL.md" <<'EOF'
---
name: c-thru-plan
---
## Phase 0

mkdir -p $PLAN_DIR/discovery $PLAN_DIR/waves $PLAN_DIR/plan $PLAN_DIR/review

## Phase 1

```
Agent(subagent_type: "keyed-agent",
  prompt: "digest:            /tmp/c-thru/x/test-slug/digests/item.md
           undeclared_secret: some_value")
```
EOF
rc=0; run_checker_in "$F10" >/dev/null 2>&1 || rc=$?
check "undeclared prompt key (undeclared_secret) → exit 1" 1 "$rc"
teardown_workspace "$F10"

# ---------------------------------------------------------------------------
# Fixture 11 — Multi-mode Mode 2 Input mismatch: invocation has mode: 2 but
# Mode 2 Input line requires "required_key" which is not in the prompt → fail.
# ---------------------------------------------------------------------------
echo "Fixture 11: multi-mode Mode 2 input mismatch → fail..."
F11=$(setup_workspace)
mkdir -p "$F11/config"
cat > "$F11/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "multi-agent": "pattern-coder" } }
EOF
# Multi-mode agent: Mode 2 Input requires mode + required_key
cat > "$F11/agents/multi-agent.md" <<'EOF'
---
name: multi-agent
model: multi-agent
tier_budget: 50000
---
# multi-agent

## Mode 1 — Build
Input: `mode` + `intent`.

## Mode 2 — Revise
Input: `mode` + `required_key`.

**Return:**
```
STATUS: COMPLETE|ERROR
```
EOF
# Caller invokes mode: 2 but omits required_key
cat > "$F11/skills/c-thru-plan/SKILL.md" <<'EOF'
---
name: c-thru-plan
---
## Phase 0

mkdir -p $PLAN_DIR/discovery $PLAN_DIR/waves $PLAN_DIR/plan $PLAN_DIR/review

## Phase 1

```
Agent(subagent_type: "multi-agent",
  prompt: "mode:   2
           missing: not_the_required_key")
```
EOF
rc=0; run_checker_in "$F11" >/dev/null 2>&1 || rc=$?
check "multi-mode Mode 2 missing required_key → exit 1" 1 "$rc"
teardown_workspace "$F11"

# ---------------------------------------------------------------------------
# Fixture 12 — Hyphenated prompt key (replan-brief) → pass.
# Agent declares Input: `replan-brief` path.  Caller passes replan-brief:.
# Pre-fix: Check 3 emits false-positive FAIL.  Post-fix: exit 0.
# ---------------------------------------------------------------------------
echo "Fixture 12: hyphenated prompt key (replan-brief) → pass..."
F12=$(setup_workspace)
mkdir -p "$F12/config"
cat > "$F12/config/model-map.json" <<'EOF'
{ "agent_to_capability": { "hyphen-agent": "pattern-coder" } }
EOF
cat > "$F12/agents/hyphen-agent.md" <<'EOF'
---
name: hyphen-agent
model: hyphen-agent
tier_budget: 50000
---
# hyphen-agent
Input: `replan-brief` path.

**Return:**
```
STATUS: COMPLETE|ERROR
```
EOF
cat > "$F12/skills/c-thru-plan/SKILL.md" <<'EOF'
---
name: c-thru-plan
---
## Phase 0

mkdir -p $PLAN_DIR/discovery $PLAN_DIR/waves $PLAN_DIR/plan $PLAN_DIR/review

## Phase 1

```
Agent(subagent_type: "hyphen-agent",
  prompt: "replan-brief: /tmp/c-thru/x/test-slug/replan.md")
```

If hyphen-agent returns ERROR, abort.
EOF
rc=0; run_checker_in "$F12" >/dev/null 2>&1 || rc=$?
check "hyphenated prompt key (replan-brief) → exit 0" 0 "$rc"
teardown_workspace "$F12"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
