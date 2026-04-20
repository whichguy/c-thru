# Local Planner Spike — dep_update Path Validation

**Status: MERGE PRECONDITION — results required before merging `refactor/unify-planner-local-first`**

This document records the evidence required by Risk #1 in the unified planner plan. The `dep_update` transition path routes to `planner-local` (local 27B+, e.g. qwen3.5:27b) instead of the cloud judge. This spike validates that the quality is acceptable before enabling that path in production.

## Pass criterion

- dep_discoveries applied correctly in ≥ 2/3 fixture test cases
- Return block parses per rules (a)–(h) in all 3 cases
- Measured clean:dep_update:outcome_risk ratio across ≥ 5 existing plan archives

## Fixture test cases

Run qwen3.5:27b (or hardware-equivalent local-planner model) on each fixture:

### Fixture 1
**wave_summary:** `test/fixtures/spike/wave_summary_01.md` (to be created)
**affected_items:** `item-4`
**Expected dep_discoveries applied:** `target_resources` for item-4 updated with `src/middleware/chain.ts`
**Result:** [ PENDING ]
**Parse check:** [ PENDING ]

### Fixture 2
**wave_summary:** `test/fixtures/spike/wave_summary_02.md` (to be created)
**affected_items:** `item-7, item-9`
**Expected dep_discoveries applied:** both items' `notes` updated
**Result:** [ PENDING ]
**Parse check:** [ PENDING ]

### Fixture 3
**wave_summary:** `test/fixtures/spike/wave_summary_03.md` (to be created)
**affected_items:** `item-2`
**Expected dep_discoveries applied:** `depends_on` updated (false dep removed)
**Result:** [ PENDING ]
**Parse check:** [ PENDING ]

## Archive ratio measurement

Measure across ≥ 5 existing plan archives in `~/.claude/c-thru-archive/`:

| Archive | Waves | Clean | dep_update | outcome_risk |
|---|---|---|---|---|
| (to be filled) | | | | |
| (to be filled) | | | | |
| (to be filled) | | | | |
| (to be filled) | | | | |
| (to be filled) | | | | |

**Aggregate ratio:** clean: __ / dep_update: __ / outcome_risk: __

## Decision

Based on spike results:
- [ ] Pass: qwen3.5:27b applied correctly in ≥ 2/3 cases AND return block valid → merge
- [ ] Partial pass: 1/3 correct → raise dep_update threshold (more cases escalate to cloud)
- [ ] Fail: 0/3 correct → accept fully-cloud dep_update path; remove planner-local from Phase 4

## Instructions to complete this spike

1. Create fixture wave_summary files in `test/fixtures/spike/`
2. Run: `ollama run qwen3.5:27b` with each fixture as input per planner-local.md contract
3. Record result and parse check per rules (a)–(h) from `test/planner-return-schema.test.js`
4. Measure ratio from archive files using `grep -c "transition_type" ~/.claude/c-thru-archive/*/pre-processor.log 2>/dev/null`
5. Fill in the table above; check the decision box; commit this file before merge
