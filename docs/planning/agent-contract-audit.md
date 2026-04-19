# Agent Contract Audit — Pre-Change Snapshot

> Status: **pre-fix**. Every BLOCKING gap documented here is addressed in subsequent commits (Buckets B–D).
> Severity: **BLOCKING** = runtime failure, silent data loss, or ambiguity that prevents reliable automation. **ADVISORY** = cosmetic drift, doc lag; safe but sloppy.

---

## agents/auditor.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `decision_out` not declared; `plan-orchestrator.md:251` passes it | BLOCKING |
| Write section | Writes `decision.json` directly at path derived from `wave_dir` context | ok |
| Return consumers | plan-orchestrator reads `.action` from `decision.json` directly; VERDICT also returned and consumed | ok |
| STATUS enumeration | No STATUS in Return; no callers read STATUS | advisory |

---

## agents/wave-synthesizer.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `brief_out` not declared; `plan-orchestrator.md:277` passes it | BLOCKING |
| Write section | Writes `replan-brief.md` + `replan-brief.INDEX.md` directly | ok |
| Return consumers | plan-orchestrator reads `STATUS` and `AFFECTED_ITEMS`; both consumed | ok |
| STATUS enumeration | `STATUS: COMPLETE\|ERROR` — orchestrator checks COMPLETE, handles ERROR via timeout/stub path | ok |

---

## agents/planner.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness (Mode 2) | "raw wave file paths (secondary)" is an unenumerated catch-all; SKILL.md Phase 4 passes `brief_INDEX`, `findings`, `artifact`, `artifact_INDEX`, `verify`, `decision`, `Verdict` — none explicitly declared | BLOCKING |
| Input completeness (Mode 1/2) | No `mode` key declared in any Mode's Input line; multi-mode check requires `mode: N` in caller for per-mode validation | advisory |
| Multi-mode handling | Check 3 skips entirely via `is_multi_mode` guard, emitting WARN | advisory |
| Return consumers | STATUS, all DELTA fields, WROTE, INDEX — all consumed by callers | ok |
| STATUS enumeration | `STATUS: COMPLETE\|ERROR` — callers check COMPLETE, timeout path covers ERROR | ok |

---

## agents/plan-orchestrator.md

| Check | Finding | Severity |
|---|---|---|
| Step 3 CYCLE return | `STATUS: CYCLE` emitted in Step 3 but NOT declared in Step 13 Return block (`COMPLETE\|PARTIAL\|ERROR` only) | BLOCKING |
| STATUS enumeration (PARTIAL) | Step 13 declares `STATUS: COMPLETE\|PARTIAL\|ERROR`; SKILL.md Phase 4 only branches `STATUS=ERROR`; `STATUS=PARTIAL` (crisis cut wave short) has no explicit branch | BLOCKING |
| STATUS enumeration (CYCLE) | SKILL.md Phase 4 has no branch for `STATUS=CYCLE` returned by Step 3 cycle detection | BLOCKING |
| Internal caller — auditor | Passes `decision_out` key; auditor Input doesn't declare it | BLOCKING (fixed in auditor.md) |
| Internal caller — wave-synthesizer | Passes `brief_out` key; wave-synthesizer Input doesn't declare it | BLOCKING (fixed in wave-synthesizer.md) |
| Internal caller — planner Mode 2 post-wave | Passes `brief_INDEX`, `findings`, `artifact`, `artifact_INDEX`, `verify`, `decision`, `Verdict` — none declared in planner Mode 2 Input | BLOCKING (fixed in planner.md) |
| VERDICT enumeration | `VERDICT: continue\|extend\|revise\|done` — all 4 values have explicit branches in SKILL.md Phase 4 | ok |

---

## agents/implementer.md

| Check | Finding | Severity |
|---|---|---|
| Write section | "Write 3 files to paths given in the prompt" — digest prompt contains only a digest path, not output paths; plan-orchestrator Step 5 is the actual writer | BLOCKING |
| Input completeness | Single `digest path` key; all callers pass digest path | ok |
| Return consumers | STATUS handled uniformly by plan-orchestrator Step 5 (valid/malformed/timeout) | ok |
| STATUS enumeration | `STATUS: COMPLETE\|PARTIAL\|ERROR` — handled by orchestrator Step 5 catch-all | ok |

---

## agents/test-writer.md

| Check | Finding | Severity |
|---|---|---|
| Write section | Same "paths given in the prompt" mismatch as implementer | BLOCKING |
| Input completeness | `digest path` — ok | ok |
| Return consumers | Uniform Step 5 handling | ok |
| STATUS enumeration | `COMPLETE\|PARTIAL\|ERROR` — catch-all | ok |

---

## agents/integrator.md

| Check | Finding | Severity |
|---|---|---|
| Write section | Same "paths given in the prompt" mismatch | BLOCKING |
| Input completeness | ok | ok |
| Return consumers | ok | ok |
| STATUS enumeration | ok | ok |

---

## agents/scaffolder.md

| Check | Finding | Severity |
|---|---|---|
| Write section | Same "paths given in the prompt" mismatch | BLOCKING |
| Input completeness | ok | ok |
| Return consumers | ok | ok |
| STATUS enumeration | ok | ok |

---

## agents/doc-writer.md

| Check | Finding | Severity |
|---|---|---|
| Write section | Same "paths given in the prompt" mismatch | BLOCKING |
| Input completeness | ok | ok |
| Return consumers | ok | ok |
| STATUS enumeration | ok | ok |

---

## agents/security-reviewer.md

| Check | Finding | Severity |
|---|---|---|
| Write section | Same "paths given in the prompt" mismatch | BLOCKING |
| Input completeness | ok | ok |
| Return consumers | ok | ok |
| STATUS enumeration | ok | ok |

---

## agents/reviewer-fix.md

| Check | Finding | Severity |
|---|---|---|
| Write section | Same "paths given in the prompt" mismatch | BLOCKING |
| Input completeness | ok | ok |
| Return consumers | ok | ok |
| STATUS enumeration | ok | ok |

---

## agents/discovery-advisor.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `intent`, `recon_path`, `gaps_out` — all declared and passed correctly | ok |
| Write section | Writes to `gaps_out` path given in prompt | ok |
| Return consumers | SKILL.md reads `GAPS` count; STATUS consumed | ok |
| STATUS enumeration | `STATUS: COMPLETE\|ERROR` — SKILL.md checks COMPLETE, uses timeout handler for ERROR | ok |

---

## agents/explorer.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `gap_question`, `output_path` — both declared and passed correctly | ok |
| Write section | Writes to `output_path` directly | ok |
| Return consumers | SKILL.md awaits completion only; `ANSWERED` field not consumed | advisory |
| STATUS enumeration | `STATUS: COMPLETE\|PARTIAL\|ERROR` — SKILL.md uses timeout handler; no explicit branch per value | advisory |

---

## agents/final-reviewer.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `intent`, `current.md`, `plan INDEX`, `journal.md`, `journal line offset`, `review_out` — all declared; SKILL.md passes all of these | ok |
| Write section | Writes to `review_out` path directly | ok |
| Return consumers | SKILL.md reads `RECOMMENDATION`; both `complete` and `needs_items` values handled explicitly | ok |
| STATUS enumeration | No STATUS in Return; RECOMMENDATION covers branching | advisory |

---

## agents/journal-digester.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `journal.md`, `CLAUDE.md`, optional `prior_findings`, `journal_digest_out` — all declared | ok |
| Write section | Writes to `journal_digest_out` path directly | ok |
| Return consumers | Manually invoked; no automated caller reads Return | advisory |
| STATUS enumeration | `STATUS: COMPLETE\|ERROR` — no automated caller; advisory only | advisory |

---

## agents/learnings-consolidator.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | Declares `learnings.md`, `prior findings.jsonl paths`, `journal.md`; plan-orchestrator also passes `learnings.INDEX` — undeclared | advisory |
| Write section | Writes `learnings.md` + `learnings.INDEX.md` directly | ok |
| Return consumers | plan-orchestrator Step 1 reads `STATUS: COMPLETE`; `TOPICS`/`NEW_TOPICS`/`SUPERSEDED` not consumed | advisory |
| STATUS enumeration | `STATUS: COMPLETE\|ERROR` — plan-orchestrator Step 1 handles both explicitly | ok |

---

## agents/review-plan.md

| Check | Finding | Severity |
|---|---|---|
| Input completeness | `current.md`, `INDEX.md`, round number, `review_out` — all declared and passed correctly | ok |
| Write section | Writes to `review_out` path directly | ok |
| Return consumers | SKILL.md Phase 3 reads `VERDICT`; both `APPROVED` and `NEEDS_REVISION` handled | ok |
| STATUS enumeration | No STATUS in Return; VERDICT covers branching | advisory |

---

## Cross-file gaps

| Gap | Location | Severity |
|---|---|---|
| `STATUS=CYCLE` unhandled | SKILL.md Phase 4 has no branch for `STATUS=CYCLE` returned by plan-orchestrator Step 3 | BLOCKING |
| `STATUS=PARTIAL` unhandled | SKILL.md Phase 4 has no branch for `STATUS=PARTIAL` (crisis cut wave short) from plan-orchestrator Step 13 | BLOCKING |
| `STATUS=CYCLE` undeclared | plan-orchestrator Step 3 emits `STATUS: CYCLE` but Step 13 Return only declares `COMPLETE\|PARTIAL\|ERROR` | BLOCKING |
| Worker write ambiguity | Seven worker agents say "Write 3 files to paths given in the prompt" but the digest contains only a digest path; plan-orchestrator Step 5 is the actual writer — contract does not resolve which side is authoritative | BLOCKING |
| planner Mode 2 revision key set | SKILL.md Phase 3 passes `findings` to planner Mode 2; planner's "secondary" catch-all doesn't enumerate it — same gap as the Mode 2 unenumerated keys finding | BLOCKING (same fix as planner.md Mode 2) |
