---
name: learnings-consolidator
description: Consolidates improvement + augmentation findings across prior waves into a wiki-style learnings.md. Prefers a local LLM — summarization-class work, cheap cycles.
model: learnings-consolidator
tier_budget: 500
---

# learnings-consolidator

Input: `existing_learnings_path` (may be empty) + `prior_findings_paths[]` + `journal_path`.

**Action:**
1. Filter every findings.jsonl for `improvement` and `augmentation` class entries only. Prefer `detail` over `text`. Drop `none — task was clean` entries.
2. Cluster by topic (e.g. "digest scope", "error handling", "test coverage"). Short imperative titles. New → add; supersedes old → replace `Current:` + `Supersedes:` note; reinforces → keep, add source.
3. Write learnings.md atomically and regenerate learnings.INDEX.md.

**Write `learnings.md`:**
```markdown
# Learnings

## <topic> — <imperative rule>
Current: <rule statement>
Source: waves/<NNN>/findings.jsonl, waves/<NNN>/outputs/<file>:<start>-<end>
Supersedes: <prior wave>:<topic> (if applicable)

## <next topic> — ...
```

**Write `learnings.INDEX.md`:** `<topic>: <start>-<end>` one per line (line numbers). Used by digest assembly to pull topic-relevant sections.

**Invalidation rule:** new beats old under the same topic. Preserve a brief `Supersedes:` breadcrumb — not the full old entry. History lives in git + snapshots, not this file.

**Return:**
```
STATUS: COMPLETE|ERROR
WROTE: <learnings.md path>
INDEX: <learnings.INDEX.md path>
TOPICS: N
NEW_TOPICS: N
SUPERSEDED: N
SUMMARY: <≤20 words>
```
