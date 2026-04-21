<!-- PHASE 3c — FULL SETUP | In: plan_path, plan_slug, ACTIVE_RISKS, flags, active_clusters | Out: pass_count=0, tracking vars, RESULTS_DIR, memo_file | → Phase 4 -->
   Print: "╔══════════════════════════════════════════════╗"
   Print: "║  ◆ CONFIG                            FULL   ║"
   Print: "╚══════════════════════════════════════════════╝"
   Print mode based on flags (key-value layout):
     IS_GAS + HAS_UI:     "  Review mode  GAS + UI (gas-eval + impact cluster + ui-evaluator)"
     IS_GAS only:         "  Review mode  GAS (gas-eval + impact + state? clusters)"
     IS_NODE only:        "  Review mode  Node.js ([N] clusters: [names] + node-eval)"
     IS_NODE + HAS_UI:    "  Review mode  Node.js + UI ([N] clusters: [names] + node-eval + ui-evaluator)"
     HAS_UI only:         "  Review mode  Standard + UI ([N] clusters: [names] + ui-evaluator)"
     All false:           "  Review mode  Standard ([N] clusters: [names])"
   Print: "  Clusters     [N] active: [comma-separated cluster names]"
   # Surface conditional gate flags so users can validate classifier decisions at pass 1.
   # Rendered as question-gate decisions (not raw booleans) to make misclassification obvious.
   Print: "  Gates        Q-C14 [✓ active | — N/A (HAS_EXISTING_INFRA=false)]"  # pick one branch based on flag
   Print: "               Q-C32 [✓ active | — N/A (HAS_UNBOUNDED_DATA=false)]"  # pick one branch based on flag
   (Raw flag debug line "REVIEW_TIER=[v] ACTIVE_RISKS=[v] IS_GAS=[v] IS_NODE=[v] HAS_UI=[v] HAS_EXISTING_INFRA=[v] HAS_UNBOUNDED_DATA=[v]"
   is printed during the convergence loop when pass_count >= 3, as a diagnostic aid for slow-convergence reviews.)
   Flags are set once and do NOT change between passes (evaluator set changes mid-loop
   would invalidate convergence state tracking).

4. **Initialize tracking:**
   ```
   pass_count = 0
   timestamp = Date.now()
   prev_needs_update_set = set()
   pass1_needs_update_set = set()  # snapshot of NEEDS_UPDATE set after pass 1 (for resolved_questions)
   total_changes_all_passes = 0    # running sum of changes_this_pass across all passes
   needs_update_counts_per_pass = []   # [7, 3, 2, ...] total NEEDS_UPDATE per pass
   pass_start_time = 0                 # reset at top of each loop iteration
   pass_durations = []                 # seconds per pass
   total_applicable_questions = 0      # computed from active_clusters + flags (set after first pass)
   memo_milestones_printed = set()     # {25, 50, 75} — each printed once
   memoized_clusters = set()       # clusters where all questions were PASS/N/A in their last pass
   memoized_since = {}             # pass_count when each cluster was memoized
   memoized_l1_questions = set()   # {Q-G11, Q-G6, Q-G7, Q-G18, Q-G28} once confirmed stable PASS or N/A (Q-G10, Q-G12, Q-G13, Q-G14, Q-G16, Q-G17, Q-G19, Q-G20, Q-G21, Q-G22, Q-G23, Q-G24, Q-G25, Q-G26, Q-G27 are not memoizable)
   l1_structural_memoized = false    # true when ALL 6 structural questions PASS/N/A for 2 consecutive passes AND no edits since
   l1_structural_memoized_since = 0
   l1_structural_clean_since = 0    # pass_count when first consecutive clean pass was observed (0 = not yet started)
   l1_process_memoized = false       # true when ALL 19 process questions PASS/N/A AND no edits since
   l1_process_memoized_since = 0
   prev_pass_results = {}          # Q-ID → PASS/NEEDS_UPDATE/N/A from previous pass (for stability-based memoization)
   # SMALL→FULL state carry-forward: advisory verdicts from a failed SMALL pass.
   # Only non-empty when REVIEW_TIER was upgraded from SMALL (small_pass_verdicts was set in Phase 3b).
   # These are NOT memoized — FULL still evaluates all questions. Used only as evaluator prompt hint.
   if isinstance(small_pass_verdicts, dict) and len(small_pass_verdicts) > 0:
     pass  # small_pass_verdicts already set in Phase 3b SMALL→FULL transition; carry forward as-is
   else:
     small_pass_verdicts = {}   # FULL started directly (no SMALL attempt); seeding is a no-op
   memoized_gas_questions = set()    # gas Q-IDs confirmed stable (structural + stability-based)
   memoized_gas_since = {}           # Q-ID → pass_count when memoized
   memoized_node_questions = set()   # node N-IDs confirmed stable
   memoized_node_since = {}          # N-ID → pass_count when memoized
   prev_gas_results = {}             # Q-ID → PASS/NEEDS_UPDATE/N/A from previous pass
   prev_node_results = {}            # N-ID → PASS/NEEDS_UPDATE/N/A from previous pass
   per_q_status_history = {}        # Q-ID → [status_per_pass] e.g. {"Q-G20": ["NEEDS_UPDATE", "PASS", "NEEDS_UPDATE"]}
                                    # Tracks per-question status across passes for oscillation detection.
                                    # A Q-ID with pattern [X, Y, X] (status flips twice) is oscillating.
   prev_pass_applied_edits = []   # list of {q_id, evaluator, summary} from previous pass
   MAX_CONCURRENT = 10             # max parallel evaluator tasks per wave; tunable (increased from 5 — typical FULL review spawns 5-7 evaluators, all fit in single wave)
   MAX_EDITS_PER_PASS = 12         # safety cap — prevent runaway plan expansion
   dispatch_start_time = 0    # set before wave spawning
   fanin_start_time = 0       # set after all waves complete
   apply_start_time = 0       # set before edit application
   pass_phase_timings = []    # [{dispatch: Ns, fanin: Ns, apply: Ns, total: Ns}] per pass
   evaluators_spawned_total = 0  # running sum of evaluators spawned across all passes
   memo_file = "~/.claude/.review-plan-memo-" + plan_slug + ".json"
   # memo_file: checkpoint written after each pass for context-compression resilience.
   # Path is stable (no timestamp) so context recovery always finds the right file.
   # If state is lost mid-loop (long reviews): re-read memo_file at start of next pass.
   advisory_findings_cache = {}
   # advisory_findings_cache: Q-ID → {"finding": "<text>", "source": "<evaluator>"}
   # Scope: Gate 3 advisory questions only (Q-G25, Q-G28).
   # Q-G20-Q-G24 are Gate 2; their descriptive PASS text is not cached (never rendered in Gate 3 section).
   # Populated each non-memoized evaluator pass (Gate 3 advisory questions only, per ADVISORY_CACHE_QIDS).
   # Later-pass entries overwrite earlier — preserves freshest advisory text.
   # Entry cleared when PASS with empty finding — signals condition was resolved by edits.
   # Persisted in memo_file checkpoint for context-compression resilience.
   ```

5. **Results directory setup:**
   ```
   RESULTS_DIR = Bash: mktemp -d /tmp/review-plan.XXXXXX
   # NOTE: use RESULTS_DIR, not $TMPDIR (macOS system env — do not overwrite)
   IF memo_file exists:
     Merge memo_file: write/update {results_dir: RESULTS_DIR} field (preserve other fields — pass_count, etc.)
   ELSE:
     Write memo_file with JSON: {results_dir: RESULTS_DIR, pass_count: 0}
   Print: "  Results      $RESULTS_DIR"
   ```
   Print: "╔══════════════════════════════════════════════╗"
   Print: "║  ◆ REVIEW                     convergence   ║"
   Print: "╚══════════════════════════════════════════════╝"
   Print: "  Beginning convergence loop — evaluating plan quality across all active layers"

6. **Error handling:** Wrap the entire convergence loop:
   ```
   IF any unrecoverable error during convergence loop:
     Bash: rm -rf "$RESULTS_DIR"
     Surface error to user via AskUserQuestion
   ```
   Orphan cleanup (run once at setup, before the loop):
   ```
   Bash: find /tmp -maxdepth 1 -name 'review-plan.*' -mmin +60 -exec rm -rf {} + 2>/dev/null
   ```

---

## Gate Tier Semantics

Gate tiers classify findings by severity and convergence impact. These definitions are canonical — do not defer to QUESTIONS.md if it is not in context.

| Tier | Label | Convergence role | SOLID/GAPS rating impact |
|------|-------|-----------------|--------------------------|
| **Gate 1** | Blocking | MUST resolve before convergence (loop continues even if changes_this_pass == 0) | Unresolved → REWORK rating |
| **Gate 2** | Important | Advisory for rating; NOT convergence-blocking once Gate 1 is clear | Unresolved → SOLID (1-3 open) or GAPS (4+ open) |
| **Gate 3** | Informational | Noted in scorecard only; never affects convergence or rating | Counted in scorecard advisory section only |

**Gate 1 question IDs by mode:**
- **Non-GAS / Non-NODE (standard):** Q-G1, Q-G11, Q-C3 (loop); Q-E1, Q-E2 (epilogue)
- **IS_GAS mode:** Q-G1, Q-G11 (L1); Q1, Q2, Q13, Q15, Q18, Q42 (gas-evaluator). Q-E1 and Q-E2 are N/A for IS_GAS (covered by Q1/Q2 and Q42).
- **IS_NODE mode:** Q-G1, Q-G11, Q-C3 (loop); Q-E1, Q-E2 (epilogue); N1 (node-evaluator)

**Gate 2** comprises all remaining questions not listed above and not designated Gate 3.
**Gate 3** questions are explicitly marked in QUESTIONS.md with `[Gate 3]`; when QUESTIONS.md is unavailable, treat all unlisted questions as Gate 2.

---

<!-- Question set updated 2026-04-10 per skills/review-plan/question-effectiveness-report.md:
     Dropped Q-G2, Q-G8, Q-C21 (0% hit rate across 18 plans including 6 adversarial).
     Conditional Q-C14 (HAS_EXISTING_INFRA), Q-C32 (HAS_UNBOUNDED_DATA).
     L1 per-pass count: 25 → 23. Gate 1 count: 3 → 2 questions (Q-G1, Q-G11).
     Classifier: Haiku → Sonnet (Haiku failed HAS_EXISTING_INFRA discrimination in Phase 2 spike).
     Updated 2026-04-11: Q-G29, Q-G30, Q-G31 added (PRs #126/#127). L1 = 26 (2 Gate 1 + 6 advisory-structural + 18 advisory-process).
     Updated 2026-04-15: Q-G32 added (source-path tracking). L1 = 27 (2 Gate 1 + 6 advisory-structural + 19 advisory-process).
     Per-pass wave breakdown: 2 + 6 + 19 = 27. -->

<!-- STATE AT END OF PHASE 3c: pass_count=0, all tracking vars init (needs_update sets, pass timings, memo vars, memoized clusters/l1, per_q_history, applied_edits, limits, RESULTS_DIR, memo_file, advisory_findings_cache), CONFIG printed. -->
