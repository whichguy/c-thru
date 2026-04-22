---
name: Wave MD Manifest
type: entity
description: "wave.md markdown format (contract v3) replacing wave.json — YAML frontmatter, 5-state checkbox items, sole-writer invariant, O_EXCL file lock, harness subcommands"
tags: [wave, harness, manifest, plan-orchestrator, c-thru-plan, contract-version, wave-lifecycle]
confidence: high
last_verified: 2026-04-22
created: 2026-04-22
last_updated: 2026-04-22
sources: []
related: [planner-design-backlog, planner-signals-design, plan-discovery-optional, cascade-scope-contraction]
---

# Wave MD Manifest

`wave.md` is the markdown manifest produced by `tools/c-thru-plan-harness.js` for each plan wave, replacing `wave.json` as of contract version 3 (commit 337f4ea, PR #41). It encodes wave state as YAML frontmatter plus GFM checkbox item blocks that the orchestrator mutates atomically throughout wave execution.

- **From Session a553415d:** Format: YAML frontmatter (fields: `wave_id`, `commit_message`, `contract_version: 3`, `batches: [[...]]` — computed by harness, must not be hand-edited) + per-item checkbox blocks. 5-state marker alphabet: `[ ]` pending, `[~]` in_progress, `[x]` complete, `[!]` blocked, `[+]` extend. Per-item attributes: `needs: [...]` (forward dep edges — renamed from `depends_on:` in current.md), `batch:`, `agent:`, `target_resources:`, `escalation_policy:`, `escalation_depth:`, `escalation_log:`, `produced:`, `wave:`. Reverse edges (`dependents:`) are NOT stored — computed on demand via `findDependents()` (O(N) linear scan over items).
- **From Session a553415d:** Sole-writer invariant: only the orchestrator calls `update-marker`; workers never write wave.md directly. Atomic write: tmp+rename. Concurrent access guarded by O_EXCL file lock (wave.md.lock). Two bugs fixed at ship: (1) lock leaked on `die()` — `process.exit()` skips finally blocks, leaving the lock orphaned and blocking all future update-marker calls; fixed by replacing `die()` inside lock scope with throw+catch, releasing lock in finally; (2) uppercase `[X]` marker silently parsed as pending — `i` flag on item regex let `[X]` match but `MARKER_TO_STATUS['X']` is undefined; fixed by normalizing captured marker to lowercase before lookup.
- **From Session a553415d:** 7 harness subcommands: `batch` (topo-sort READY_ITEMS → wave.md, with schema round-trip validation), `update-marker` (RMW item checkbox state with O_EXCL lock; flags: `--status`, `--escal-depth`, `--escal-log-append`), `targets` (sorted unique target_resources paths, exit 1 on parse error), `inject-contract` (prepend shared/_worker-contract.md to each digest), plus internal `parseWaveMd`, `writeWaveMd`, `findDependents`. Field rename contract: `depends_on` lives in current.md; `needs` lives in wave.md — translation happens in `cmdBatch`, never mixed within a file.
- **From Session a553415d:** v2→v3 migration path: three options surfaced in SKILL.md Phase 0 — (1) drain: call `readWaveJson()` (legacy fallback, emits deprecation warning to pre-processor.log) to finish the in-flight v2 wave, then immediately call `writeWaveMd()` to promote to wave.md before any update-marker calls; (2) discard: archive plan dir, start fresh on v3; (3) abort. `--escal-log-append <json>` flag on update-marker was added to support Step 5r RECUSE handling where the orchestrator must append recusal log entries without breaking the sole-writer invariant.

→ See also: [[planner-design-backlog]], [[planner-signals-design]], [[plan-discovery-optional]], [[cascade-scope-contraction]]
