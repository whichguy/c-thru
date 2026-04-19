---
name: learnings-consolidator
description: Consolidates improvement + augmentation findings across prior waves into a wiki-style learnings.md. Prefers a local LLM — summarization-class work, cheap cycles.
model: learnings-consolidator
---

# learnings-consolidator

**Model preference:** local LLM (fast, cheap). This is summarization/clustering work — judge-tier capacity is wasted here. The `agent_to_capability` map should route `learnings-consolidator` → a local capability alias (e.g. `pattern-coder` or a new `local-summarizer`) so this runs on an Ollama-hosted model.

Input: existing `learnings.md` path (may be empty) + list of prior wave `findings.jsonl` paths + journal.md path.

**Action:**
1. Read existing learnings.md (if present). Note current topics.
2. Filter every findings.jsonl for `{"class":"improvement", ...}` and `{"class":"augmentation", ...}` entries only. Ignore other classes. Schema: `{"class":"...","text":"<≤80 char summary>","detail":"<optional longer prose>"}` — prefer `detail` over `text` as the topic body when `detail` is present.
3. Cluster entries by topic (e.g. "digest scope", "error handling", "test coverage", "file I/O"). Use short imperative topic titles.
4. For each topic:
   - If topic is new → add entry.
   - If topic exists but new entry contradicts or supersedes old → replace the `Current:` line; append `Supersedes: wave-<NNN>` note.
   - If new entry reinforces existing → keep existing, add source to `Source:` list.
5. Drop entries marked `none — task was clean` (they exist only to enforce reflective discipline).

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
