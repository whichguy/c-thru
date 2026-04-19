<!-- ADDING A QUESTION: (1) add row here with gate weight, (2) update Gate1_unresolved
     formula in SKILL.md if weight=3, (3) add Q-ID to evaluator's assigned list in
     SKILL.md loop body. All 3 steps required. -->

# Review-Plan Question Definitions

## Gate Weight Reference
Gate 1 (blocking, weight 3) | Gate 2 (important, weight 2) | Gate 3 (advisory, weight 1)
N/A counts as PASS for gate evaluation.

---

## Layer 1: General Quality

*27 questions (Q-G1, Q-G4 through Q-G7, Q-G10 through Q-G14, Q-G16 through Q-G32). Applies to every plan, every domain.*

For each question: evaluate → **PASS** / **NEEDS_UPDATE** / **N/A**
- PASS: criterion is met
- NEEDS_UPDATE: criterion is missing or incomplete → edit the plan, mark `<!-- review-plan -->`
- N/A: see N/A column
(These are the only valid evaluator outputs — no other statuses.)

**Gate 1 — Blocking (weight 3):**

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-G1 | Approach soundness | Right solution? Simpler alternatives with valid rejection? Flag fallacies (false dichotomy, straw man, authority). Flag: (1) unsubstantiated constraints (need test/error/doc evidence); (2) manual steps when automatable; (3) additive path when replacement shrinks maintenance; (4) new dependency when native suffices. | never |
| Q-G11 | Existing code examined | Cites code read: paths, function names, current behavior. Flag: vague refs without names. GAS: .gs names or mcp_gas cat cited. | pure new-file work only |
**Gate 2 — Important (weight 2):**

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-G4 | Unintended consequences | Off-site side effects: broken workflows, behavioral/perf regressions, security shifts? | trivial isolated change |
| Q-G5 | Scope focus | On-target, no scope creep? | never |
| Q-G10 | Assumption exposure | Flag implicit high-risk assumptions (environment, APIs, data, third-party). Targets: "should work", unvalidated env deps, TBD markers, evidence-free "won't work" claims. Stated assumptions acceptable if explicit; unvalidated constraints need cited evidence (test, error, doc, platform limit). Unresolved decisions → flag unless investigation steps or low-risk annotation present. Rules: "assume X" → flag if high-risk; "TBD" → always flag; contradictions → flag. (Lightweight — cross-phase depth: Q-G21.) | no external calls, no environment-specific dependencies, no pre-existing data assumptions; and no open-question markers (TBD / will need to investigate) in implementation steps |
| Q-G12 | Code consolidation | Substantive overlap addressed? If overlap: consolidate or defer with reason. Flag: touches near-identical logic without acknowledging. (Structural overlap only; utility reuse → Q-C12.) | purely additive (new file / new feature) with no substantively similar existing implementations |
| Q-G13 | Phased decomposition | Phases group distinct concerns, each completing implement→test→commit before next? Flag: (1) flat list mixing concerns without phase breaks; (2) commit before test; (3) implicit cross-phase deps without checkpoints; (4) per-phase `/review` (→ Q-E2). | single atomic concern with no cross-phase dependencies (e.g. fix exactly one bug, rename one identifier, add one isolated function) |
| Q-G14 | Codebase style adherence | Changes follow existing patterns; deviations stated with reason. Flag: unacknowledged divergence from comparable code. | documentation-only change with no proposed code; or brand new project with no existing comparable code to inherit style from |
| Q-G18 | Pre-condition verification | Edit without prior read? OK: "Read X to confirm Y"/"verify Z before". EDIT: unverified → [EDIT: before step N: "Read [path], verify [expectation — e.g., fn X ~line Y]"] | pure new-file creation with no existing files to verify; or plan modifies only documentation where current state is irrelevant |
| Q-G20 | Story arc coherence | 4 story-arc elements explicit? (1) problem/need — trigger + current-state delta, (2) approach + rationale, (3) expected outcome, (4) testable verification. Good: "test X passes", "endpoint returns Y for input Z". Bad: "it works", "no errors". May span sections but each must be explicit. Flag: missing elements; jumping to implementation. EDIT: `[EDIT: inject after title: "## Context\n[Problem and current-state]\n\n## Approach\n[Method and rationale]\n\n## Expected Outcome\n[Success state and verification]"]`. | IS_TRIVIAL; or change is self-evidently scoped (e.g., "fix typo in line 42 of README") where all 4 elements are implicit in a single sentence |
| Q-G21 | Internal logic consistency | Cross-phase premise consistency? Flag: contradictory premises ("cache for perf" vs "changes every request"), circular reasoning, incompatible state assumptions (stateless + sessions), evidence-free false dichotomies. EDIT: `[EDIT: [phase X] "[quoted]" vs [phase Y] "[quoted]" — resolve by [align/investigate]]`. | single-phase plan with no stated assumptions or premises; IS_TRIVIAL |
| Q-G22 | Cross-phase dependency explicitness | Cross-phase deps verified? Flag: ref to artifact missing from prior phase outputs; no pre-consumption check; assumed-exists; silent wrong-result on output mismatch. EDIT: `[EDIT: Phase [M] end: "**Outputs:** [list]" | Phase [N] start: "**Pre-check:** verify [artifact] exists, matches [format]"]`. | single-phase plan; phases are purely additive with no inter-phase data/artifact/interface dependencies. (Format contract: Q-G9f parses the exact `**Outputs:**` and `**Pre-check:**` markers injected by this question's EDIT. Changes to these marker names must update Q-G9f's algorithm step (a) in both QUESTIONS.md and SKILL.md. When this question is N/A, Q-G9f is also N/A — no Outputs/Pre-check annotations exist to parse.) |
| Q-G23 | Proportionality | Effort proportional to problem? Flag: (1) over-engineering (bug fix->5 phases, minor->restructure, one-off->abstraction), (2) multi-phase for single-phase work, (3) single-use abstractions, (4) TeamCreate for Tasks/inline, (5) phase-per-file. EDIT: `[EDIT: consolidate Phases [X]+[Y] -- same concern. Single phase: "[description]"]`. | IS_TRIVIAL; plan is already single-phase; problem is explicitly complex (new system, multi-service integration, architectural migration) |
| Q-G24 | Core-vs-derivative ordering | Are core constructs specified before and more deeply than derivatives? Two applications: (a) Implementation plans: foundational functions/schemas/interfaces fully specified before wiring, callers, or tests that depend on them — flag ordering inversions. (b) Review/criteria plans: core questions (with downstream deps) specified deeper than derivatives — flag equal depth despite unequal weight. EDIT: `[EDIT: move [construct/Q-ID] spec before step N (its first dependent); deepen core Q(s) [Q-IDs] step N: add criteria, examples, processing]`. | documentation or config-only plan with no new code constructs AND no criteria batteries |
| Q-G25 | Feedback loop completeness | Flag: output consumed by another tool without rejection/partial-success/quality handling. EDIT: `[EDIT: after step N: "Read [tool] output; adjust [artifact] if [threshold] not met"]` | plan output is terminal (user-facing only, not consumed by another tool/skill); plan is self-contained with no downstream integration |
| Q-G26 | Domain convention alignment | Follows domain conventions (REST, OAuth, framework idioms)? New domain → research step? Flag: reinventing solved patterns, tech against its conventions, new domain sans research. | trivial change; pure refactoring; domain conventions already established in codebase and checked by Q-G14 |
| Q-G27 | Assumption validation spike | Unproven risky claims (API behavior, perf, compat) need spike/POC before dependents? Complements Q-G10 (missing evidence → generate evidence). Flag: building on unverified assumptions. EDIT: `[EDIT: before step N: "Spike: [assertion] — test confirming [expected]"]`. N/A-supersession: When Q-G30 fires on the same assumption as Q-G27, Q-G27 → N/A-superseded by Q-G30 (Q-G30 covers Q-G27 as a subset for pre-execution spikes). | all assertions backed by cited evidence (docs, test results, prior codebase experience); IS_TRIVIAL |
| Q-G30 | Experiments Required Before Execution | **Experiments Required Before Execution.** Does the plan rest on any unverified empirical assumption whose resolution could *materially change the plan's structure*? Look for: (a) performance claims without measurement ("this will halve latency"); (b) API behavior assumptions untested for an upstream library/service ("I expect X to be idempotent"); (c) classifier/heuristic capability claims ("Haiku can discriminate this") without a validating spike; (d) data-shape assumptions ("the corpus is mostly small files") without inspection. **Action**: recommend a named experiment/spike with explicit pass/fail criteria BEFORE implementation steps begin, and flag which later steps depend on the spike result. EDIT: `[EDIT: before step 1: "## Spike: [name]\n- Hypothesis: [assertion]\n- Method: [how to test]\n- Pass criteria: [measurable outcome]\n- Steps that depend on this result: [N, M, ...]"]`. **Not in scope**: post-implementation verification (Q-E1), routine testing (Q-C4), minor sanity checks. **Q-G27 supersession:** When Q-G30 fires on an assumption, immediately mark Q-G27 N/A-superseded by Q-G30 for that assumption at the evaluation step — do not evaluate Q-G27 independently for the same claim. **Decision framework:** fire when the plan presents an empirical claim as settled fact where a 5–30 minute spike could disprove it and would materially change the plan's structure; do not fire for well-understood technology choices with strong prior evidence. | all empirical assumptions backed by cited evidence (measurement, prior spikes, platform documentation); IS_TRIVIAL; plan explicitly scopes a validating spike before implementation steps |
| Q-G31 | Accidental Feature Removal | **Accidental Feature Removal.** Does the plan remove, comment out, or disable any code that could be a live entry point even though it appears unreachable via static analysis? Look for: (a) async/event-driven entry points with no direct internal caller — GAS triggers (onEdit, doGet, doPost, onOpen), EventEmitter listeners, queue consumers, webhook handlers, scheduled jobs, message-bus subscribers; (b) code reached only via dynamic dispatch, string-keyed lookup, or reflection (e.g., `handler[eventType]()`, `require(moduleName)`, method-name construction); (c) exported symbols or public API surface with no internal callers that may have external consumers (downstream services, test harnesses, plugin interfaces, documented SDK surface). **Action**: for each flagged removal, require either (i) grep/coverage evidence confirming no callers, or (ii) explicit plan statement "confirmed dead via [evidence]". EDIT: `[EDIT: before step N: "Confirm dead: grep -r '[name]' src/ returns only this definition; no async callers (triggers/events/queue)"]`. **Not in scope**: code the plan explicitly confirms is dead via grep evidence, coverage data, or framework documentation; purely additive changes with zero removals. | plan is purely additive — no code is removed, commented out, or disabled |

**Gate 3 — Advisory (weight 1):**

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-G6 | Naming consistency | New names match codebase style? | no new names |
| Q-G7 | Documentation | MEMORY.md/CLAUDE.md/README affected? | no behavior changes |
| Q-G16 | LLM comment breadcrumbs | Complex changes (new modules/logic/architecture): LLM-navigable comments at key points planned? Acceptable: function-boundary or navigation comments. Flag: complex changes, no comment/nav aids. | documentation-only change; configuration change; trivial single-line/single-function fix; or plan explicitly defers documentation to a separate task |
| Q-G17 | Phase preambles | >=2 phases: 1-3 sentence intent preamble per phase — why it exists, downstream setup. Flag: steps sans narrative. EDIT if absent: [EDIT: before Phase N steps: "> Intent: [why + what it sets up]"]. One per missing. | single-phase plan (requires ≥ 2 distinct phases); IS_TRIVIAL |
| Q-G19 | Phase failure recovery | Multi-phase: partial-commit risk addressed? Accept: phases independently safe, revert steps, or stop-and-assess gates. Flag: later-phase failure leaves prior commits broken with no acknowledgment. | single-phase plan; or phases are purely additive with no inter-dependency (each phase's commit is independently valid) |
| Q-G28 | Context skills invoked | Domain decisions sans project context when retrieval skills available (system-reminder)? Flag: no invocation or confirmation unnecessary. EDIT: `[EDIT: before Phase 1: "Invoke [skill] for [topic] to load domain context"]`. | no context-gathering skills in system-reminder; or purely mechanical (rename, config tweak, dependency bump) |
| Q-G29 | File/State Organization | **File/State Organization.** Do any of the files or state the plan creates/modifies need to be re-organized to align with existing project conventions — without being overly nuanced? Look for: (a) new files placed in a directory with a naming or subdirectory convention the plan ignores; (b) new state (config keys, env vars, cache paths, temp files) that duplicates an existing canonical location; (c) additions to a module with natural subdivision points the plan doesn't respect. **Not in scope**: bikeshedding on cosmetic ordering, hypothetical future conventions, refactors unrelated to the plan's core change. N/A: purely additive new-directory creation with no pre-existing convention to align with; or plan explicitly addresses organization in its scope statement. **Decision framework:** fire when a concrete convention violation is identifiable from the plan text (e.g., "plan adds config key to X.json but existing canonical location is Y.yaml"); apply the "overly nuanced" guard when the convention is implicit, contested, or requires subjective judgment about naming style. | purely additive new-directory creation with no pre-existing convention to align with; or plan explicitly addresses organization |
| Q-G32 | Source-path tracking | When new code uses a variable that can be set by two or more upstream branches, does the plan introduce a tracking flag/discriminant to carry the branch context to the consumption point? Flag: variable assigned in N≥2 upstream branches but used in a downstream conditional or argument whose correct value depends on *which* branch set it — with no plan step to track that. EDIT: `[EDIT: step N: "introduce [flag] set to [value-A] after [branch A] and [value-B] after [branch B]; use [flag] to select [behavior] at [consumption point]"]`. | variable is always set by a single upstream path; or all branches produce equivalent results at the consumption point (no per-branch context needed) |

Count L1 edits → `l1_changes += count` (27 questions total, combined into `changes_this_pass` in Convergence Loop)

### Q-G9 Post-Convergence Organization Pass

*Runs once after the convergence loop exits. Not part of per-pass L1 evaluation.*
*L1 per-pass count stays at 27 (Q-G1, Q-G4 through Q-G7, Q-G10 through Q-G14, Q-G16 through Q-G32). Q-G9 is not included in*
*convergence loop scoring. Q-E1 and Q-E2 are post-convergence epilogue questions (not per-pass).*
*Q-G9 is N/A if plan has fewer than 3 implementation steps.*

**Sub-question definitions:**

| Sub-Q | Question | Criteria |
|-------|----------|----------|
| Q-G9a | Sequential clarity | Steps numbered sequentially, unambiguous ordering, legible at a glance? |
| Q-G9b | Concurrency labeling | Parallel steps marked (e.g. "[parallel]", "In a SINGLE message", "spawn in parallel")? |
| Q-G9c | Scannability | Headers+bullets used (no prose walls >5 sentences)? |
| Q-G9d | Conditional structure | Are IF/ELSE branches visually distinct from sequential steps? |
| Q-G9e | Checkpoint visibility | Commit/verification checkpoints visible (not buried mid-paragraph)? |
| Q-G9f | Execution graph | 3+ phases: dep graph via **Outputs**/**Pre-check**. N deps M when Pre-check refs Outputs. Waves: W1=no deps, WK=all prior; same-wave=parallel. EDIT if parallelism sans schedule: `## Execution Schedule\nWave 1: [X]\nWave 2 [parallel]: [Y],[Z]\n\nSpawn [Y]+[Z] as parallel Tasks after [X]`. Sequential → PASS. N/A: <3 phases or Q-G22 N/A. |

---

## Layer 2: Code Change Quality

*38 questions organized into 6 concern clusters. Cluster-level triage activates/deactivates
entire clusters based on Sonnet pre-classification. Active clusters are listed in active_clusters
computed in Step 0.*

### Cluster 1: Impact & Architecture

*12 questions. Always active.*

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C3 | 1 | Impact analysis | Other callers/features affected? Cross-ref call sites checked? | fully isolated |
| Q-C8 | 2 | Interface consistency | Modified signatures match siblings; callers updated? | no sig changes |
| Q-C12 | 3 | Duplication | No reimplementation of existing utilities? (Utility/library scope; structural: Q-G12.) | no new functions |
| Q-C14 | 2 | Bolt-on vs integrated | New code extends existing modules vs parallel bolt-ons? Could it replace rather than duplicate? Flag: new file/module for existing module's concern without evaluating extension/supersession. (Integration scope. Mechanism: Q-G1.) | purely additive; HAS_EXISTING_INFRA=false (no comparable existing infrastructure in plan) |
| Q-C26 | 2 | Migration tasks | Persistent data/config/API changes need migration? Flag: key renames, shape changes, feature removal, schema changes sans migration path. | no change to existing data formats or persistent state |
| Q-C27 | 2 | Backward compatibility | Public API/CLI/export/event schema/config breaking changes: migration path or versioning (v2, semver, deprecation) included? | internal-only change, no external API consumers |
| Q-C32 | 2 | Bulk data safety | Unbounded data (paginated APIs, DB results, file/log listings): chunked/streamed/paginated? Flag: full load sans guard; unbounded loops; uncapped accumulation. EDIT: `[EDIT: step N: "Process [source] in batches of [N] with [progress tracking]"]`. | HAS_UNBOUNDED_DATA=false; all operations are bounded by design (fixed-size config, known-small dataset, single-record lookup) |
| Q-C35 | 2 | Agent cognitive load | Agent analytical load calibrated to input complexity? Flag: >6 deep-reasoning questions against >500-line input in one call. EDIT: `[EDIT: split step N into [K] sub-tasks, each covering [question subset] against [relevant portion]]`. | plan does not dispatch agents; or all agent calls are simple retrieval/read operations with no analytical burden |
| Q-C37 | 2 | Translation boundary specification | Abstract→concrete steps specified? Flag: creative step gets minimal spec ("convert X to [artifact]" sans mapping/format/criteria). EDIT: `[EDIT: step N: "**Methodology:** [abstract input]→[concrete output] + examples"]` | no abstract-to-concrete translation steps; all outputs are trivially derivable from inputs |
| Q-C38 | 2 | Cross-boundary API contract | Cross-boundary call (different repo/package/independently-versioned module): assumed signature matches target's current def? Flag: (1) from memory sans Read; (2) arg count/order mismatch; (3) destructuring nonexistent return props; (4) adapter masking unverified gap. Scope: inter-repo or different independently-versioned package; same-repo calls (including same-repo HTTP schema contracts) → Q-C8, not here. EDIT: `[EDIT: before step N: "Read [target], verify [function] signature: [args] → [return]"]`. | single-repo change with no cross-boundary function calls; all called interfaces are defined within the same package/repo |
| Q-C39 | 2 | Data access pattern vs schema | Config/DB/API/store reads: key paths match schema/type def? Flag: (1) root-level access on `{[id]: object}` dict; (2) nonexistent property access; (3) flat/nested mismatch; (4) fallback on impossible key — undefined-silent masking schema error; (5) CLI subprocess output parsed by column/field position (awk `$N`, cut `-fN`, positional regex) without a pinned tool version or documented output schema — CLI authors may add/reorder columns. Scope: read-path; write-path: Q-C26. EDIT: `[EDIT: before step N: "Read [source] schema, verify [key path] exists with [expected shape]"]`. | no data reads from structured sources; or all access patterns verified by a Read step in the plan; or no structured-output CLI calls whose output is parsed positionally |
| Q-C40 | 2 | Guidance-implementation consistency | Each behavioral claim in guidance/narrative/comments has implementing step? Flag: (1) "X reads Y" but no step touches X; (2) documented capability sans step; (3) comment-code contradiction; (4) claimed side effect sans step. (Scope: plan-internal.) EDIT: `[EDIT: in [section], remove/correct "[quoted]" — no step produces this behavior]`. | plan contains no guidance text, documentation sections, or inline comment descriptions |

IS_GAS: **partially superseded** — Q-C3 (→Q18), Q-C8 (→Q16), Q-C12 (→Q39), Q-C14 (→Q41) are superseded; Q-C27 N/A (no external API consumers in GAS projects); Q-C32 (→Q22/Q25/Q26) superseded. **Q-C26, Q-C35, Q-C37, Q-C38, Q-C39, Q-C40 have no gas equivalent — evaluate normally** (always active via impact cluster).
IS_NODE: Q-C32 → N/A-superseded (node N14). Q-C35, Q-C37, Q-C38, Q-C39, Q-C40: not superseded — evaluate normally. All other questions: not superseded — evaluate normally.

### Cluster 2: Testing & Plan Quality

*6 questions. Always active.*

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C4 | 2 | Tests updated | Tests updated for changed signatures, new error paths, bug fixes? Flag: missing test for any. EDIT: [EDIT: after step N: "Test [function] — new signature/error paths/regression"]. | pure visual |
| Q-C5 | 2 | Incremental verification | Each step has a checkpoint (not all-testing-at-end)? | single atomic |
| Q-C9 | 2 | Step ordering | Explicit DAG; no refs to uncreated files, no deploy-before-push? | single step |
| Q-C10 | 2 | Empty code | No stubs/TODOs without full spec (phased OK if explicit)? | no placeholders |
| Q-C11 | 3 | Dead code | Old implementations marked for removal? | nothing replaced |
| Q-C29 | 2 | Test strategy defined upfront | Test strategy upfront? Acceptable: named cases, behavior coverage, or "existing tests suffice." Flag: logic changes sans pre-stated acceptance criteria. | cosmetic/doc-only change; single-line fix where correctness is self-evident; existing test suite explicitly confirmed as sufficient |
| Q-C43 | 2 | Test-blast radius alignment | Tests cover all callers/workflows identified as affected? Flag: impact analysis names N consumers but tests only cover changed function. EDIT: [EDIT: in test section: "Verify [affected caller] still works"]. | no callers/workflows identified as affected; self-contained change |

IS_GAS: **fully superseded** — skip this cluster when IS_GAS=true (gas-evaluator Q11, Q12, Q17, Q19, Q20; Q-C29 N/A — test strategy covered by gas-evaluator Q11/Q12). **Q-C43 has no gas equivalent — evaluate normally** when IS_GAS=true AND testing cluster is active.
IS_NODE: not superseded — evaluate normally.

### Cluster 3: State & Data Integrity

*5 questions. Active when HAS_STATE=true. Skip entire cluster when HAS_STATE=false.*
*(Q-C26 promoted to Cluster 2: Impact & Architecture — always active.)*

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C13 | 2 | State edge cases | Persistent storage: state-exists + state-absent covered? | no storage |
| Q-C18 | 2 | Concurrency | Shared state locked; background tasks: concurrency plan? | read-only |
| Q-C19 | 2 | Idempotency | Retry-safe operations; mutations deduped? **MUST: if plan notes idempotency risk without prescribing a fix (existence check, dedup guard, or idempotency confirmation step) → NEEDS_UPDATE.** EDIT: `[EDIT: after "[quoted risk note]": "If [operation] is not idempotent, add [existence check / dedup guard] before calling; annotate with // ARCH: comment explaining the invariant."]` | read-only |
| Q-C24 | 2 | Local↔remote sync | Local→remote sync strategy explicit? Stale reads avoided? | local-only |
| Q-C36 | 2 | Persistence staleness | Persisted artifacts reused: staleness check (hash/timestamp/version)? Flag: reuse sans source-change verification → silent downstream errors. EDIT: `[EDIT: step N: "Before reusing [artifact], verify [source] unchanged (compare [hash/timestamp/version])"]`. | no persistent intermediate artifacts; all artifacts are ephemeral within a single run |

IS_GAS: **partially superseded** — Q-C13 (→Q40), Q-C18 (→Q21), Q-C19 (→Q24), Q-C24 (→Q3).
  **Q-C36 has no gas equivalent — evaluate Q-C36 normally** when IS_GAS=true AND HAS_STATE=true (activate state cluster; mark Q-C13/Q-C18/Q-C19/Q-C24 as N/A-superseded within evaluator).
IS_NODE: **Q-C18 → N/A-superseded** (covered by node-evaluator N8).

### Cluster 4: Security & Reliability

*7 questions. Always active (low overhead).*

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C15 | 2 | Input validation | Untrusted inputs sanitized at trust boundaries? | no untrusted input |
| Q-C16 | 2 | Error handling | Try/catch external calls; actionable errors; fail-loud noted? (Sync; async→Q-C30.) | no new error paths |
| Q-C22 | 2 | Auth/permission additions | New API services/OAuth scopes/permissions — user impact noted? Flag: (1) GAS services (DriveApp, GmailApp) sans scope note; (2) OAuth scopes sans re-auth note; (3) permission changes sans impact note. EDIT: `[EDIT: add to Context: "**Scope change:** adds [scope] — existing users need re-authorization"]`. | no new services |
| Q-C30 | 2 | Async error completeness | Every async path has error handler? Flag: (1) promise/callback sans try/catch/.catch(); (2) fire-and-forget sans annotation; (3) event handler sans boundary; (4) scheduled task sans error reporting. EDIT: `[EDIT: step N: "wrap [async call] in try/catch with [error reporting]"]`. | no async operations introduced or modified |
| Q-C31 | 2 | Resource lifecycle cleanup | Resources (connections, pools, timers, procs, subscriptions) have cleanup in shutdown/error paths? Flag: unclosed connection/pool, uncleared timer, unterminated proc, dangling subscription. EDIT: `[EDIT: step N: "In shutdown/error handler: [close/clear/terminate] [resource]"]`. | no persistent resources created (purely computational, no I/O, no subscriptions); IS_GAS (isolated execution — no persistent processes) |
| Q-C33 | 2 | Configuration validation | New config deps (env vars, files, flags, credentials): startup fail-fast? Flag: (1) no startup check; (2) no schema validation; (3) first-use-deferred errors; (4) undocumented keys. EDIT: `[EDIT: step N: "Validate [key] at startup — fail descriptively if missing/malformed"]`. | no new configuration dependencies introduced |
| Q-C34 | 2 | External call timeouts | Timeouts on all outbound calls (HTTP, DB, APIs)? Flag: (1) HTTP sans connect/response timeout; (2) DB sans statement timeout; (3) API sans deadline; (4) retries sans max duration; (5) ≥2 sequential probes on a hot path without a documented cumulative budget — per-call timeouts are necessary but not sufficient; N probes × T seconds compound into N·T worst-case user-visible latency. EDIT: `[EDIT: step N: "Set [timeout type] timeout of [N]s for [call]. On timeout: [fallback]. If multi-probe: acknowledge cumulative worst-case as (N × T)s or cap via overall deadline"]`. | no outbound external calls introduced |

IS_GAS: **fully superseded** — skip this cluster when IS_GAS=true (gas-evaluator Q27, Q28, Q23; Q-C30→Q28, Q-C31→N/A isolated exec, Q-C33→Q8, Q-C34→Q22).
IS_NODE: **Q-C16, Q-C30, Q-C31, Q-C33, Q-C34 → N/A-superseded** (Q-C16→N6, Q-C30→N6/N7, Q-C31→N13/N27, Q-C33→N9/N10, Q-C34→N28). Q-C15 and Q-C22 remain active.

### Cluster 5: Operations & Deployment

*6 questions. Active when HAS_DEPLOYMENT=true. Skip entire cluster when HAS_DEPLOYMENT=false.*

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C6 | 2 | Deployment defined | Push steps, target env, verification specified? | local-only |
| Q-C7 | 2 | Rollback plan | Recovery path if deployment fails? | no deployment |
| Q-C20 | 3 | Logging | Informative but compact; no sensitive data? | no server changes |
| Q-C23 | 3 | External rate limits | API quotas/throttling accounted for? | no new API calls |
| Q-C28 | 3 | Observability | Monitoring/alerting addressed? Acceptable: existing dashboards, log-based alerts, or current monitoring confirmed sufficient. | local-only or dev-environment-only deployment |
| Q-C41 | 2 | Feature rollback | Post-merge production reversal strategy? Flag: irreversible data migrations sans rollback script, no feature flag for risky behavior changes, schema changes sans down-migration. EDIT: `[EDIT: add to Context: "**Rollback:** [strategy — feature flag / revert commit / down-migration / manual steps]"]`. | change is trivially revertible (config tweak, doc-only, additive with no data migration) |
| Q-C44 | 3 | Change observability | Production verification strategy? Flag: behavior change sans logging/metric/alert. Acceptable: existing monitoring confirmed sufficient, new log line, or dashboard update. | no production-observable behavior change; local/dev-only |

IS_GAS: **fully superseded** — skip this cluster when IS_GAS=true (gas-evaluator Q9, Q10, Q29, Q22, Q25); Q-C28 N/A (exec verification + Q6/Q12 cover GAS observability). **Q-C41 has no gas equivalent — evaluate normally** when IS_GAS=true AND operations cluster is active.

### Cluster 6: Client & UI

*2 questions. Active when HAS_UI=true. Skip entire cluster when HAS_UI=false.*

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C17 | 2 | Event listener cleanup | Listeners removed to prevent accumulation/leaks? | no new listeners |
| Q-C25 | 3 | UI error boundary | Client error boundary for silent failures? window.onerror, try/catch on init. | no new client logic |

IS_GAS: **fully superseded when HAS_UI=true** (gas-evaluator Q32, Q33).
  When HAS_UI=false and IS_GAS=true, no cluster evaluator is spawned for this cluster.
IS_NODE: not superseded — evaluate normally.

Count cluster edits → `cluster_changes_total += count` (combined into `changes_this_pass` in Convergence Loop)

---

## Layer 3: UI Specialization

*9 questions (Q-U1 through Q-U9). Active when HAS_UI=true. Evaluated by ui-evaluator each pass.*

*For each question: evaluate → **PASS** / **NEEDS_UPDATE** / **N/A***

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-U1 | Component structure | Reusable UI components? Flag: monolithic HTML, duplicated patterns, no layout/state/interaction split. | no new UI components |
| Q-U2 | State management | UI states (loading/error/empty/data) explicit? Spinner/skeleton, error display, empty-state copy? | purely presentational changes with no dynamic state |
| Q-U3 | Interaction feedback | User actions give immediate feedback? Disable-during-submit, progress indicator, success/error toast. | no interactive elements |
| Q-U4 | Responsive & layout constraints | Container-aware? GAS sidebar=300px, dialog≤600px. No overflow or fixed widths breaking sidebar. | no layout/sizing changes |
| Q-U5 | Accessibility basics | Accessible labels (aria-label, for/id on inputs)? Logical tab order, keyboard nav intact. | no new interactive elements |
| Q-U6 | Visual consistency | Matches design system (fonts, colors, spacing, buttons)? No one-off inline styles diverging from patterns. | no visual changes or the project has no existing baseline |
| Q-U7 | UI design narrative | Design narrative present? Section titled UI Design Narrative/User Experience/Design Intent, 2-5 sentences on flow+states+rationale. Flag: impl sans narrative. EDIT: `## UI Design Narrative\n**User experience**: [flow]\n**Design intent**: [rationale]\n**State transitions**: [loading/error/empty/success]`. | purely presentational changes with no interaction or new components; plan explicitly references an existing design spec |
| Q-U8 | Iterative UI verification | Plan includes visual verification step using chrome-devtools, screenshots, or similar tooling to validate the UX after implementation? Flag: UI changes with no verification beyond "it renders." EDIT: `[EDIT: add verification step: "Take screenshot with chrome-devtools / open sidebar and verify [specific UX behavior]"]`. | no visual UI changes; backend-only; plan uses an existing E2E test suite that covers the UI |
| Q-U9 | CSS/HTML organization | CSS/HTML follows cohesive organization? Flag: inline styles over classes, no separation of layout/theme/component styles, no naming convention, scattered style definitions, HTML mixing structure and presentation. | no CSS/HTML changes; purely JS/logic changes; project has no existing CSS baseline to align with |

Count ui-evaluator edits → `ui_plan_changes += count` (combined into `changes_this_pass` in Convergence Loop)

---

## Post-Convergence Questions

*3 questions. Evaluated once after convergence loop exits.
Not part of per-pass evaluation or convergence scoring.*

| Q | Gate | Question | When |
|---|------|----------|------|
| Q-G9 | — | Organization pass | inline (team-lead) |
| Q-E1 | 1 | Git lifecycle | epilogue (team-lead) |
| Q-E2 | 1 | Post-implementation workflow | epilogue (team-lead) |

Q-G9 sub-questions (Q-G9a through Q-G9f) are defined in the Layer 1 section above.

### Q-E1: Git lifecycle (was Q-C1)

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-E1 | 1 | Git lifecycle | Branch named? Each phase: explicit git add+commit? Push-to-remote? Merge/PR to main? Commit msg conventions? | never |

IS_GAS: N/A — covered by gas-evaluator Q1, Q2.

### Q-E2: Post-implementation workflow (was Q-NEW)

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-E2 | 1 | Post-implementation workflow | Post-impl section (after impl, not bundled) has all 4: (1) `/review-fix` loop→0 findings, (2) build if applicable, (3) tests if any, (4) fail→fix→re-run `/review-fix`→re-run until pass. All imperative, not optional. Flag: user-optional or user-confirmation language. EDIT: absent→inject `## Post-Implementation Workflow` (all 4); missing step 4→append. | IS_GAS (covered by Q42 in gas-plan) |

IS_GAS: N/A — covered by gas-evaluator Q42.

---

## Inactive Questions

<!-- Inactivated 2026-04-10 per question-effectiveness-report.md §2 DROP: 0% hit rate across 18 plans including 6 adversarial. Retained here for historical reference; NOT evaluated by any active evaluator. -->

### Q-G2 (was Gate 1): Standards compliance

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-G2 | Standards compliance | CLAUDE.md/MEMORY.md compliance? (IS_GAS: non-GAS scope only — Verification Protocol, Agent Teams, Tool Prefs; GAS directives → Q13.) | never |

**Why inactive:** 0% hit rate across 18 plans including 6 adversarial. Well-prompted plans inherently follow CLAUDE.md conventions; adversarial plans that violate conventions do so in ways caught by Q-G1 (Approach soundness) and Q-G4 (Unintended consequences). Dropped from Gate 1 — Gate 1 is now Q-G1 + Q-G11 (+ Q-C3 for non-GAS/non-NODE).

### Q-G8 (was Gate 2): Task & team usage

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-G8 | Task & team usage | Decision Framework level correct? Flag: heavy work inline (->Task), serial-when-parallel Tasks, no TeamCreate for coordinated agents. | plan involves only a single atomic change with no parallelizable steps and no heavy operations |

**Why inactive:** 0% hit rate across 18 plans — no plans in the bench bank misused agent dispatch. All adversarial plans returned N/A.

### Q-G8 Decision Framework: Task Calls & Agent Teams (archived)

Evaluate plans against three levels. Each level subsumes the previous.

**Level 1 — Task calls for context isolation**
Use Task (no team) when a step is independent but would pollute the main context:
- Broad codebase exploration or file reads (>5 files)
- Output-heavy operations (large grep results, full file dumps)
- Research/investigation that produces intermediate artifacts not needed in main context
- Long-running operations where progress doesn't need real-time visibility

Flag: plan runs heavy exploration or multi-file reads inline instead of via Task.
Note: context isolation is a valid reason to use Task even for sequential (non-parallel) work.

**Level 2 — Parallel Task calls for independent work**
Use multiple Task calls in a single message when steps are independent:
- Editing multiple independent files (each file in its own Task)
- Running tests while continuing other work (run_in_background: true)
- Exploration from multiple angles simultaneously (up to 3 Explore agents)
- Independent verification steps (lint + test + type-check in parallel)

Flag: sequential steps that could run in parallel; steps that wait for results
they don't depend on.

**Level 3 — Agent teams (TeamCreate/SendMessage) for coordinated work**
Use TeamCreate when multiple agents need to share findings or coordinate:
- Multi-concern implementations (e.g., backend agent + frontend agent, with
  team-lead merging results and resolving conflicts)
- Iterative convergence (multiple evaluators per pass, like review-plan itself)
- Parallel hypothesis testing (debugging with competing theories)
- Complex features spanning 5+ files with cross-cutting concerns

Flag: plans with 3+ agents working on related concerns without team coordination;
plans where Agent A's output feeds into Agent B's work but there's no team structure;
multi-file features where cross-file consistency needs a coordinator.

**When NOT to escalate:**
- Single file, simple change → no agents needed (inline)
- 2 independent files, no shared concerns → Level 2 (parallel Tasks, no team)
- Purely additive changes with no cross-file dependencies → Level 2

### Q-C21 (was Operations cluster): Runtime constraints

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C21 | 2 | Runtime constraints | Execution time/memory/platform limits addressed? Unbounded ops chunked? (Scope: runtime; data-volume: Q-C32.) | bounded ops |

**Why inactive:** 0% hit rate across 18 plans. All adversarial plans returned N/A. IS_NODE was previously N/A-superseded by node-evaluator N22; with Q-C21 now inactive, the supersession note was also removed.
