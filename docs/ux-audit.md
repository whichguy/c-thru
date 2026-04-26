# c-thru UX cohesion audit (2026-04-26)

A holistic look at how the product's surfaces compose, where the user's mental model
fragments, and what we'd change. **Pre-GA**: breaking changes are fine.

Findings are ranked by **user impact** (how often a real user hits this), with concrete
fixes. Each fix is tagged: `[ship]` (low-risk, can land now), `[plan]` (deserves a planning
cycle first), `[breaking]` (will rename/remove a public surface — pre-GA OK).

---

## High-impact findings

### 1. **15 modes is too many to navigate without categorisation** ⚠️

`c-thru --help` currently lists all 15 modes as a flat alphabetical-ish list. They fall
into **4 categories** the help doesn't reveal:

| Category | Modes | What user controls |
|---|---|---|
| **Connectivity** | `connected`, `offline`, `local-only` | Where calls go (cloud vs local) |
| **Slot-based** | `semi-offload`, `cloud-judge-only`, `cloud-thinking`, `local-review`, `cloud-best-quality`, `local-best-quality` | Per-capability cloud/local mix |
| **Provider-filter** | `cloud-only`, `claude-only`, `opensource-only` | Exclusivity policy (must / must-not match) |
| **Ranking** | `fastest-possible`, `smallest-possible`, `best-opensource` | Pick the data-best model |

Without categorisation, a user trying to pick "cheap" can't tell whether `local-only`,
`offline`, `cloud-judge-only`, or `local-best-quality` is the right answer. They all
sound plausible.

**Fix [ship]:** restructure the `--mode` help block to group by category with a one-line
description per category. The mode list goes from "wall of words" to "I can find what I
want."

### 2. **No `c-thru explain` — users can't see the resolution chain** ⚠️

Resolution traverses **5 layers**: agent → agent_to_capability → capability → mode-resolver →
fallback_chains/filters/ranking. When something routes unexpectedly, the user has no way
to ask "why did this happen?" without reading source.

**Fix [plan]:** add `c-thru explain --capability <cap> --mode <mode> [--tier <tier>]` that
prints the resolution as a chain. Example:

```
$ c-thru explain --capability workhorse --mode best-opensource --tier 64gb
agent           : (any agent mapping to 'workhorse')
capability      : workhorse              (via agent_to_capability)
slot candidate  : claude-sonnet-4-6      (entry.connected_model)
filter (best-opensource)
  → walk model_routes ranking by quality_per_role.generalist
  → qualifiers: gemma4:26b-a4b (q=5.0, 102 t/s), qwen3.6:35b-a3b (q=5.0, 60 t/s), …
  → pick: gemma4:26b-a4b (highest t/s tiebreak)
final           : gemma4:26b-a4b
backend         : ollama_local (http://localhost:11434)
```

This is `git log --graph` for routing. Eliminates the most common "why did it pick that?"
class of confusion.

### 3. **Env var prefix inconsistency: 3 prefixes for one product** ⚠️

| Prefix | Examples | Scope |
|---|---|---|
| `CLAUDE_ROUTER_*` | `CLAUDE_ROUTER_DEBUG`, `CLAUDE_ROUTER_NO_UPDATE` | Bash router (`tools/c-thru`) |
| `CLAUDE_PROXY_*` | `CLAUDE_PROXY_BYPASS`, `CLAUDE_PROXY_DEBUG`, `CLAUDE_PROXY_JOURNAL` | Node proxy (`tools/claude-proxy`) |
| `CLAUDE_LLM_*` | `CLAUDE_LLM_MODE`, `CLAUDE_LLM_MEMORY_GB` | Resolution semantics |

The split is by **implementation layer**, not by **user intent**. Users don't know whether
"this is router behavior" or "this is proxy behavior" — and shouldn't have to.

**Fix [breaking]:** harmonize to two namespaces by user intent:
- `CTHRU_*` for runtime behavior (was: `CLAUDE_ROUTER_*`, `CLAUDE_PROXY_*`)
- `CLAUDE_LLM_*` stays — it's about LLM resolution, distinct concept

Pre-GA we can rename without alias chains. Update install.sh, README, CLAUDE.md, all docs.
Document in CHANGELOG that env vars renamed.

### 4. **No "I want to..." index in docs** ⚠️

User has an intent ("save costs", "audit my agent", "always use Claude"), but the docs are
organized by **mechanism** (modes, env vars, config). They have to read the whole feature
catalog and synthesize.

**Fix [ship]:** add an "I want to..." section to README and `docs/connectivity-modes.md`:

| I want to... | Use |
|---|---|
| Save money — minimize cloud calls | `--mode local-best-quality` (or `local-only` if no internet) |
| Use the best model for each task regardless of cost | `--mode cloud-best-quality` |
| Audit my agent's outputs for compliance | `CLAUDE_PROXY_JOURNAL=1` |
| Use only Claude (no GLM, no openrouter, no local) | `--mode claude-only` |
| Use the fastest model that's good enough | `--mode fastest-possible` |
| Use cloud for high-stakes decisions, local for everything else | `--mode cloud-judge-only` |
| Use cloud for thinking-class tasks, local for workers | `--mode cloud-thinking` |
| Inspect why a request was routed somewhere | `c-thru explain ...` (after #2 ships) |

This single table delivers more discoverability than the entire current docs.

---

## Medium-impact findings

### 5. **Subcommand vs flag style is inconsistent**

- `c-thru --list` (flag-style)
- `c-thru check-deps` (subcommand)
- `c-thru reload` (subcommand)
- `c-thru restart` (subcommand)
- `c-thru --help`, `c-thru -h` (flag-style only — no `c-thru help`)

User needs to remember which is which. The pattern for "operations on the proxy" should be
consistent.

**Fix [ship]:** keep both for the most-used (`--help` ↔ `help`, `--list` ↔ `list`) and
document that subcommands and flags are equivalent for these. Don't break what already works.

### 6. **`local-only` and `offline` are essentially aliases**

Both resolve to `disconnect_model`. Documented as semantically distinct
("offline" = no internet detected, "local-only" = preference even with internet) but in
practice they do the same thing.

**Fix [keep]:** semantic distinction is real and useful (different `mode` values in the
journal/logs). Keep both. Already documented in `docs/connectivity-modes.md`.

### 7. **`--mode + --profile + --route + --model` precedence is undocumented**

Looking at the code, the precedence is:
1. `--route` selects a named route → resolves to a model
2. `--model` overrides if both are passed
3. `--mode` and `--profile` set env vars (CLAUDE_LLM_MODE, CLAUDE_LLM_PROFILE) — orthogonal
4. The proxy uses mode + profile to resolve the slot from the chosen model's capability

Not stated anywhere user-visible. A user who passes all four has no way to predict the
result.

**Fix [ship]:** add a "Flag precedence" subsection to README Usage section:
```
When multiple flags are passed:
  --model <X>     → forces concrete model X for this invocation
  --route <name>  → uses route name unless --model also passed
  --mode <M>      → orthogonal — affects which slot is picked from the resolved capability
  --profile <T>   → orthogonal — overrides hw tier detection
```

### 8. **Mode interactions: ranking modes ignore filter modes**

You can't say "fastest opensource model" — `fastest-possible` and `opensource-only` don't
compose. The first mode wins, the second is ignored.

**Fix [plan]:** mode composition is a real feature gap. Either:
- Accept comma-separated modes: `--mode fastest-possible,opensource-only`
- Or interpret some modes as "modifiers" stacking on top of others

`best-opensource` partially addresses this (it IS "best of opensource"). But there's no
"fastest of cloud" or "smallest of opensource". Worth designing if users ask.

### 9. **Error messages don't suggest next steps**

When `cloud-only` mode hard-fails because no cloud option exists for a capability:
```
{"error":{"message":"workhorse: mode=cloud-only has no compliant model (primary 'qwen3:1.7b' rejected, 0 fallback candidates also rejected)"}}
```

Tells them WHAT, not what to DO. A user gets stuck.

**Fix [ship]:** error message extensions:
```
... (primary 'qwen3:1.7b' rejected, 0 fallback candidates also rejected).
Suggestion: try `--mode connected` (uses cloud_best_model when available) or
`--mode cloud-best-quality` (forces best cloud, falls back to local).
```

Same pattern for unknown agent names, unknown modes, etc. — small "did you mean?" footer.

### 10. **`check-deps` output doesn't link to fix**

Currently: `WARN ollama not installed`. User has to figure out where to install from.

**Fix [ship]:** every WARN/ERROR has a "Fix:" line with concrete next-step command, e.g.
`brew install ollama` or URL. Most already do this; audit for gaps.

---

## Lower-impact findings (improvements, not pain points)

### 11. **`/v1/active-models` endpoint isn't surfaced in `--help`**

Power-user feature. Not a problem; flag for the doc audit (#7).

### 12. **15 env vars on a busy single-user system are noisy**

Most users will set 0 or 1. Documented in env vars table. Not actionable beyond that.

### 13. **The plan file output (.claude/plans/typed-popping-lagoon.md) is opaque**

Users see "typed-popping-lagoon" as the active plan. Naming is whimsical but not
self-descriptive. Not a c-thru issue — that's plan-mode tooling.

### 14. **The shipped config change history is in commits, not docs**

Per the new memory rule (commits journal rationale). Can document in a `docs/CHANGELOG.md`
that summarizes user-facing changes per release tag.

---

## Recommended fix order (concrete improvements that can ship now)

In order of impact-per-effort:

1. **Mode help categorisation** [ship] — restructure `cmd_help` mode block (~10 lines edit, big clarity win)
2. **"I want to..." index** [ship] — README + connectivity-modes.md (~30 mins; massive discoverability)
3. **Flag precedence section in README** [ship] — explicit precedence table (~5 mins)
4. **Error message suggestions** [ship] — add 1-2 lines to hard-fail errors (~30 mins per error path)
5. **`c-thru explain` subcommand** [plan] — biggest UX win; needs design (separate plan)
6. **Env var prefix harmonisation** [breaking] — pre-GA window is the time; needs migration sweep

This audit's near-term deliverable: items 1-3 ship in the next session. The rest become
tasks.

---

## Tasks generated by this audit

If accepting this audit's recommendations, file the following follow-up tasks:

- **Apply UX fixes 1-4** (mode categorisation, "I want to" index, precedence section,
  error suggestions) — bundle as one PR.
- **Plan & implement `c-thru explain`** (#fix-5 above) — separate plan
- **Env var prefix harmonisation** (#fix-6) — separate plan; pre-GA migration with
  CHANGELOG entry; no alias chains since pre-GA

Cross-reference: this audit feeds into #7 (doc refresh) and #10 (test coverage — `c-thru
explain` would need its own tests).
