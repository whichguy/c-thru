---
name: update-model-research
description: |
  Research and update docs/local-model-prompt-techniques.md with latest
  community findings, Ollama version-specific fixes, and authoritative
  corrections for all local models in config/model-map.json.
  Spawns parallel research agents per model family, applies a strict
  citation and confidence standard, and writes a diff-summary of changes.
  Invoked as /update-model-research [--model <family>] [--section <topic>]
color: yellow
---

# /update-model-research — Research Refresh

Keeps `docs/local-model-prompt-techniques.md` current as Ollama, model families,
and community knowledge evolve. Runs five phases: Inventory → Research → Delta Analysis → Update → Change Summary.

## Input

- `$ARGUMENTS` (optional):
  - `--model <family>` — restrict to one model family: `qwen`, `gemma`, `gpt-oss`, `devstral`
  - `--section <topic>` — restrict to a doc section: `thinking`, `tools`, `json`, `penalties`, `fa`, `context`
  - `--dry-run` — research only; print proposed changes without editing the file
  - `--cite-check` — re-verify existing citations only; skip new-finding search
  - no args → full refresh of all model families

Pre-flight: verify `docs/local-model-prompt-techniques.md` and `config/model-map.json`
both exist. If either is missing, print an error and stop.

**`--cite-check` early exit:** If `--cite-check` is set, skip all research phases.
For each URL found in the Sources sections of `docs/local-model-prompt-techniques.md`,
issue a HEAD request and verify it returns 200 OK. Report dead links with their
section context. Make no other edits. Print results and stop.

---

## Phase 1 — Inventory

### 1a. Extract active local models

Read `config/model-map.json`. Collect every model name whose value in
`model_routes` is `"ollama_local"` or `"ollama_cloud"`. Group by family:

| Family | Match pattern |
|---|---|
| `qwen` | `qwen3`, `qwen3.5`, `qwen3.6`, `qwen3-coder` |
| `gemma` | `gemma4` |
| `gpt-oss` | `gpt-oss` |
| `devstral` | `devstral` |
| `other` | anything else (mistral-small, deepseek, glm, etc.) |

Print: "Active local models: <list>". If `--model` flag is set, filter to
that family only.

If `--section` flag is set, note the active section filter. Valid values and
the doc sections they restrict research to:

| `--section` value | Restricts research to |
|---|---|
| `thinking` | `/think`, `/no_think`, thinking mode, think tags, budget control |
| `tools` | Tool calling, tool format, tool parsing, FIM |
| `json` | Structured output, `format=`, grammar sampler |
| `penalties` | `repeat_penalty`, `presence_penalty`, Go runner sampling |
| `fa` | Flash Attention, `OLLAMA_FLASH_ATTENTION` |
| `context` | `num_ctx`, context window, KV cache |

Pass the active section filter to each research agent in Phase 2. Agents must
restrict their search and output to findings relevant to that section only.

### 1b. Snapshot the current doc

Read `docs/local-model-prompt-techniques.md`. Extract:

1. **Doc date** — the `as of` date in the file header (or file mtime if absent).
2. **Per-model version references** — scan for Ollama version numbers mentioned
   (`v0.17.5`, `v0.20.3`, etc.) and which claims they are associated with.
3. **Open-bug list** — scan for phrases `open`, `open issue`, `no fix`, `pending`,
   `unresolved`, `needs more info` and collect those claim summaries.
4. **Disputed claims** — scan for `⚠️ Disputed`, `unverified`, `not confirmed`.
5. **Fixed-in-version claims** — scan for `fixed in`, `shipped in`, `merged in`.

Write snapshot to a temp variable `DOC_SNAPSHOT` (do not write to disk).
Print the open-bug count and disputed-claim count as a brief summary.

---

## Phase 2 — Parallel Research

Spawn one research agent per active model family (or one if `--model` is set).
All agents run in parallel. Each agent receives:
- The family's model names
- The open bugs and disputed claims for that family from the DOC_SNAPSHOT
- The doc's current Ollama version references
- The research directives below

### Research Agent Directives (apply to all family agents)

Each agent MUST:

**A. Version-change scan**
Search for Ollama release notes and GitHub PRs merged since the doc's last
recorded version for each mentioned model. Specifically look for:
- Release notes at `github.com/ollama/ollama/releases` mentioning the model family
- Merged PRs with titles containing the model name
- Closed issues that were marked open in the doc (check if status changed)

**B. New Ollama-specific bugs and fixes**
Search `github.com/ollama/ollama/issues` for issues opened or updated in the
last 90 days mentioning the model family. Flag:
- New bugs not yet in the doc
- Issues the doc marked "open" that are now CLOSED (with how they were resolved)
- Issues the doc marked "fixed" that have regression reports

**C. Authoritative corrections**
Search for responses by:
- Model makers (Qwen/Alibaba team, Google/DeepMind, OpenAI, Mistral) in:
  - HuggingFace model card discussions
  - Official GitHub repos (`QwenLM/`, `google-deepmind/`, `mistralai/`, `openai/`)
  - Official documentation pages
- Ollama maintainers (`jmorganca`, `drifkin`, `dhiltgen`, `rick-github`, `pdevine`,
  `ParthSareen`) in GitHub issues/PRs
- Corrections must be: (a) directly contradicting a doc claim, or (b) confirming
  a disputed doc claim, or (c) nuancing an oversimplified claim

**D. Community findings (high-signal only)**
Search Reddit `r/LocalLLaMA`, Ollama community forum, and HuggingFace discussions
for findings that are:
- Reproducible (multiple independent confirmations, not single user reports)
- Specific to Ollama's behavior (not general model behavior)
- Not already in the doc

**E. Dissenting opinions**
For each major claim in the doc, look for credible community members or official
sources explicitly disagreeing. A "dissent" must be from a named source with
a URL — not just "some users report otherwise."

### Per-family search targets

**qwen family:**
- `github.com/ollama/ollama` issues/PRs: `qwen3`, `qwen3.5`, `qwen3.6`, `qwen3-coder`
- `github.com/QwenLM` repos: new issues, maintainer responses in discussions
- HuggingFace: `Qwen/Qwen3-*`, `Qwen/Qwen3.5-*` model pages and discussions
- Ollama releases: any note mentioning Qwen3.5 tool calling, thinking, Go runner
- Focus areas: thinking-mode API, penalty sampling (Go runner fix status), tool
  call format (v0.17.6 fix follow-on reports), qwen3.6 hybrid thinking

**gemma family:**
- `github.com/ollama/ollama` issues/PRs: `gemma4`
- `github.com/google-deepmind/gemma` issues
- `github.com/ggml-org/llama.cpp` issues: `gemma4`
- Focus areas: FA implementation status (any new PR after #15311 revert), grammar
  sampler bug (any fix in progress), 26b MoE empty-response (issue #15428 update),
  tool calling parser (follow-on to PR #15254), e4b tool unreliability (issue #15315)
- New: any Ollama release since 0.20.x mentioning Gemma4

**gpt-oss family:**
- `github.com/ollama/ollama` issues/PRs: `gpt-oss`
- `huggingface.co/openai/gpt-oss-20b` discussions (check for new official responses)
- OpenAI Cookbook updates at `developers.openai.com/cookbook`
- Focus areas: structured output bug (PR #14288 — merged or still open?),
  reasoning_effort reliability, tool call incomplete bug (#12187), Harmony format
  updates from OpenAI

**devstral family:**
- `github.com/ollama/ollama` issues/PRs: `devstral`
- `huggingface.co/mistralai/Devstral-*` discussions
- `github.com/mistralai/mistral-vibe` updates
- Mistral official docs for any devstral changelog
- Focus areas: multi-step tool call AVAILABLE_TOOLS bug (#11296 fix status),
  Unsloth 2507 GGUF template issue (resolved?), FIM support clarification,
  devstral 2 (2512) standard function calling confirmation

### Research output format

Each agent returns a structured report with these sections:

```
## VERSION CHANGES
- [FIXED in vX.Y.Z] <brief claim> | Cite: <URL>
- [STILL OPEN] <brief claim> | Last updated: <date> | Cite: <URL>
- [REGRESSION] <brief claim> | Cite: <URL>

## NEW FINDINGS
- [CONFIRMED] <brief finding> | Source: <URL> | Confidence: high/medium
- [COMMUNITY REPORT] <brief finding> | Source: <URL> | Reproduced: yes/no

## AUTHORITATIVE CORRECTIONS
- [CORRECTS DOC CLAIM] "<doc claim>" → "<what authority says>" | Authority: <name+org> | Cite: <URL>
- [CONFIRMS DISPUTED] "<disputed claim>" → confirmed/denied | Authority: <name+org> | Cite: <URL>
- [NUANCES] "<doc claim>" → "<nuance>" | Authority: <name+org> | Cite: <URL>

## DISSENTING OPINIONS
- [DISSENT] "<doc claim>" dissented by <name+source> | Cite: <URL> | Basis: <summary>

## NO CHANGE
- <list of doc sections verified accurate — brief>
```

Agents MUST NOT include:
- Single-user anecdotes without corroboration
- Claims without a URL citation
- Speculation about future behavior
- Restatements of what the doc already says (put those in NO CHANGE)

---

## Phase 3 — Delta Analysis

Receive all agent reports. For each finding:

### Classification rules

| Finding type | Action |
|---|---|
| FIXED in version already noted in doc | Skip (already documented) |
| FIXED in version NOT in doc | → UPDATE: mark the claim as fixed, add version |
| STILL OPEN issue doc marked fixed | → CORRECTION: mark regression, note version |
| NEW FINDING, confirmed | → ADD to appropriate section |
| NEW FINDING, community-only | → ADD with `⚠️ Community report — not independently verified` tag |
| AUTHORITATIVE CORRECTION | → UPDATE: replace the claim, cite the authority |
| CONFIRMS DISPUTED claim | → UPDATE: resolve the disputed tag |
| DISSENT (credible) | → ADD dissent note inline in the relevant paragraph |
| NO CHANGE verified | → No edit; log in change summary |

### Citation standard (MUST apply to every change)

Every added or changed claim must have:
1. A URL to the primary source (issue, PR, discussion, docs page, release note)
2. The name of the person or org who said it (for authoritative corrections)
3. The date or version number if time-sensitive

Reject any research finding that cannot meet this standard — do not add it to the doc.

### Confidence labels to apply

Apply inline labels when the evidence base warrants it:
- No label = confirmed by maintainer or model maker (highest confidence)
- `*(community consensus)*` = multiple independent reports, no official statement
- `*(disputed)*` = conflicting reports with no resolution
- `*(unverified)*` = single source, plausible but not corroborated

---

## Phase 4 — Update

If `--dry-run` is set: print the proposed changes as a unified diff-style summary
and stop. Do not edit the file.

Otherwise, edit `docs/local-model-prompt-techniques.md`:

### Edit conventions

**For a fixed bug** — update the claim in place:
```
~~[OLD CLAIM]~~ **[FIXED in vX.Y.Z]** <new accurate claim> ([PR #NNNN](...))
```
Or if the fix fully supersedes the claim, rewrite the sentence and add a
version note: `(fixed in vX.Y.Z, PR #NNNN)`.

**For a new authoritative correction** — follow the existing doc pattern:
```
**[CORRECTED — FIXED] "old claim."**
<explanation of correction>. Authority: <Name/Org> stated: *"exact quote"*
*Source: [<link text>](<url>)*
```

**For a new finding** — add to the appropriate section, following the existing
prose style. If the section doesn't exist yet, create it under the correct
model-family heading.

**For a confirmed-disputed claim** — remove the `⚠️ Disputed:` prefix and
update the text to reflect the confirmed state, citing what confirmed it.

**For a new dissent** — add inline after the existing claim:
> **Dissent:** <Name/Source> disputes this: <summary>. ([source](<url>))

**For a regression** — mark the previously-fixed claim:
```
⚠️ **REGRESSION reported (vX.Y.Z):** <what the regression is>. ([issue #NNNN](...))
```

### Do not change

- The document header or metadata
- Confirmed-accurate claims (from NO CHANGE sections)
- The Sources lists (add new sources to the relevant sub-list, don't restructure)
- The "Authoritative Corrections & Disavowals" section structure — append new
  entries; do not rewrite existing ones unless they are themselves wrong

### Update the doc header

After all edits, update the header line `Covers models active in config/model-map.json
as of <date>` to today's date.

---

## Phase 5 — Change Summary

Print a compact summary of every change made:

```
## Update Summary — <date>

### Fixes applied (claims updated with version-specific resolutions)
- <model>: <brief>  [vX.Y.Z, PR/issue #]

### New findings added
- <model>: <brief>  [source]

### Authoritative corrections applied
- <model>: <brief>  [authority, source]

### Disputed claims resolved
- <model>: <brief>  [confirmed/denied by source]

### No change verified for
- <list of families/sections>

### Skipped (insufficient citation)
- <list of findings rejected due to missing URL or single-source>
```

If `--dry-run`, print this summary with `[DRY RUN — no file changes made]` as
the final line.

---

## Quality Gates

Before finishing, verify:

1. Every change in the doc has a URL citation in the same paragraph or in the
   Sources section. If any change lacks one, revert it and add it to "Skipped."
2. No claim uses the word "always" or "never" unless backed by an official
   statement from the model maker or Ollama maintainer.
3. No version-specific fix is stated as current behavior without noting the
   minimum version required and the re-pull requirement if applicable.
4. The "Authoritative Corrections & Disavowals" section has not had any existing
   entry deleted or reworded without a stronger authoritative source.
5. Run a quick grep for any remaining stale version references — e.g. if a bug
   was "open as of v0.20.3" and has now been fixed, the "open as of" phrase
   must be removed or updated.

---

## Error handling

- If a research agent returns no findings: log "No new findings for <family>"
  and continue.
- If a source URL returns a 404 or is inaccessible: mark that finding as
  unverifiable and skip it.
- If two agents return conflicting claims about the same issue: report the
  conflict in the change summary as "CONFLICT — needs human review" and do not
  edit the doc for that claim.
- `--cite-check` is handled in Pre-flight and exits before this phase is reached.
