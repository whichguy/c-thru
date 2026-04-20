# TODO: Agent/contract-checker improvements from audit learnings

Captured from the agent-contract deep audit (PRs #21/#22). Five follow-up items that
were out-of-scope for that work but should not be lost.

---

### ~~Item 1 — Fix awk hyphen gap in Checks 3 and 7~~ ✓ DONE (PR #23)

---

### Item 1b — Add F12b negative companion fixture (TEST-COVERAGE)

**File:** `tools/c-thru-contract-check.sh`

**File:** `test/c-thru-contract-check.test.sh`

F12 (PASS case) was added in PR #23. The reviewer noted a missing negative companion:
agent declares `other-key` only, caller passes `replan-brief:` → Check 7 should FAIL.
F2 provides general missing-key coverage but does not cover the hyphenated-key
false-negative path specifically. Low priority but closes the regression loop.

---

### Item 6 — Fixture test harness: patched SKILL.md needs STATUS branch coverage (TEST-INFRA)

**File:** `test/c-thru-contract-check.test.sh`

Discovered while writing F12: Check 6 (STATUS/VERDICT coverage) fires on fixture SKILL.md
files that declare `STATUS: COMPLETE|ERROR` in the agent's Return block but don't include
an ERROR-handling branch in the SKILL.md caller. The fixture had to add `"If hyphen-agent
returns ERROR, abort."` to pass Check 6. This is correct behavior, but it means every future
fixture must remember to include STATUS branches or it will fail Check 6 rather than the
check under test — masking real failures. Consider adding a `write_skill` helper to
`setup_workspace` that generates a minimal SKILL.md with all STATUS values covered, so
fixture authors only override what they're testing.

---

### Item 2 — Optional key declaration notation (CONVENTION-GAP)

**Files:** `agents/planner.md`, future multi-mode agents

No syntactic convention distinguishes required keys from optional ones in `Input:` lines.
Forced a compromise in Mode 2: only truly-required keys in backticks; optional keys as prose.
Check 7 skips multi-mode agents entirely as a workaround.

Proposal: adopt `[optional]` suffix in Input lines:
```
Input: `mode` + `current.md` + `INDEX` + `replan-brief`[optional] + `findings`[optional]
```
Update `agent_tokens()` to strip `[optional]` before token extraction and track optional
vs required status. Check 3 would WARN (not FAIL) for optional tokens absent from an
invocation. Check 7 would still FAIL if a caller passes a key that is neither required nor
optional in the Input line. This also unblocks Check 7 coverage for multi-mode agents.

---

### Item 3 — Extend Check 3/7 to scan plan-orchestrator.md (COVERAGE-GAP)

**File:** `tools/c-thru-contract-check.sh`

Checks 3 and 7 only parse SKILL.md. `agents/plan-orchestrator.md` uses a different
prompt-close format (`",` + separate `timeout:` line + `)`) that the awk doesn't handle —
explicitly excluded to avoid false positives. Auditor/wave-synthesizer/learnings-consolidator
invocations inside plan-orchestrator are never validated.

Fix: extend the awk close-prompt detection to also recognize lines ending with `",` as a
valid prompt close (`$0 ~ /",$/`). Then re-enable
`awk_agent_blocks "$ORCHESTRATOR" >> "$tmpblocks"` for Checks 3 and 7.
Add fixture F13: plan-orchestrator-format invocation (prompt closes with `",`) with a
missing declared key → exit 1.

---

### Item 4 — Standardize Return block header convention (DOC-DRIFT)

**File:** `agents/plan-orchestrator.md`

All agents use `**Return:**` as the Return block header. `plan-orchestrator.md` uses
`## Step 13 — Return STATUS` instead. The `extract_return_values()` awk in the contract
checker needed a special regex `\#\# Step [0-9].*Return` to match this one-off.

Fix: add a `**Return:**` marker line immediately above the Step 13 code fence in
`plan-orchestrator.md`, OR rename "## Step 13 — Return STATUS" to "## Step 13 — Return"
and add `**Return:**` above the code block. Either removes the special-case awk branch.

---

### Item 5 — Codify W1 response structure as new-agent convention (DOC-GAP)

**File:** `docs/agent-architecture.md`

The W1 pattern (worker produces structured response; orchestrator parses and writes
artifacts) was resolved ad-hoc during the audit. New agents added to the wave system
should know which pattern to follow by default. Add a "Response conventions" section to
`docs/agent-architecture.md`:

- **Wave-worker agents** (dispatched by orchestrator Step 5 inner loop, per-item artifacts):
  use W1 — structured response with `## Work completed`, `## Findings (jsonl)`,
  `## Output INDEX` sections. Orchestrator writes the artifacts.
- **Phase-agents** (dispatched once per wave phase — auditor, wave-synthesizer, review-plan,
  final-reviewer, discovery-advisor, etc.): write files directly and return paths in STATUS block.
- **Distinguishing heuristic:** if the agent is dispatched in a loop over plan items and
  produces per-item artifacts → W1. If dispatched once per phase → direct-write.

---

### Item 6 — Add signal-based multi-mode matching to Checks 3 and 7 (SIGNAL-MODE-GAP)

**File:** `tools/c-thru-contract-check.sh`

**Context:** The refactored `planner` agent uses `## Signal 1/2/3` headers with three
`Input:` lines instead of `## Mode N` headers. The contract checker's multi-mode detection
(`is_multi_mode`) counts `Input:` lines correctly, so planner is treated as multi-mode.
However, Check 3 matches invocations to mode sections via `mode: N` synthetic token in the
prompt — not via `signal:` key. Result: all planner invocations generate WARN (no mode: key)
and are skipped. Check 7 is skipped entirely for multi-mode agents.

**Impact:** Low — the WARNs are non-fatal and the actual key alignment is correct. But
signal-based invocations are unvalidated.

**Fix:** Extend `awk_agent_blocks` to emit a synthetic `SIGNALKEY:<value>` token when
`signal:` key is present in prompt. Extend `is_multi_mode` to detect `## Signal N` headers
in addition to `## Mode N`. Match invocations to signal sections by SIGNALKEY token.
