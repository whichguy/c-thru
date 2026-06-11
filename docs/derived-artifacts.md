# Derived artifacts & self-updating docs

Several files in this repo are **derived** from `config/model-map.json` (+ `agents/*.md`): they
restate routing facts in a human-readable form. A derived artifact that is hand-maintained will
silently drift the next time the config changes — exactly the failure mode that cost a session of
snapshot archaeology. The fix is the **generate → verify-on-commit** pattern: a generator writes the
artifact, and a `--check` mode in the pre-commit hook fails the commit if the committed copy differs
from a fresh generation.

## Tier 1 — shipped

| Artifact | Generator | Gate |
|---|---|---|
| README "Agent routing reference" table | `tools/gen-routing-doc.js` (wraps `c-thru-explain.js --all`) | `.githooks/pre-commit` runs `gen-routing-doc.js --check`; `make docs` regenerates |
| Lineage snapshot (`test/model-map-lineage.test.js#SNAPSHOT`) | `node test/model-map-lineage.test.js --update` (anchors on the `const SNAPSHOT = {` … `};` block; exits 1 loudly if the block is not found — it must never silently no-op) | the test itself fails on any cell drift |

`gen-routing-doc.js` pins `c-thru-explain.js` to the repo `config/model-map.json` via
`CLAUDE_MODEL_MAP_PATH` so generation is deterministic (never reads the runtime
`~/.claude/model-map.json`). The table lives between sentinel markers in `README.md`
(`<!-- BEGIN routing-table … -->` … `<!-- END routing-table -->`); everything outside the markers is
hand-maintained prose.

A second derived surface — the `agents/*.md` roster and dispatch graph in
[`docs/agent-architecture.md`](agent-architecture.md) — is kept honest at test time instead of commit
time: `test/agent-dispatch-graph.test.js` (every `subagent_type` resolves agent→capability→model) and
`test/agent-mapping-complete.test.js` (every agent resolves to a live endpoint).

## Tier 2 — shipped: `make regen`

One target rebuilds all derived artifacts after a config bump: lineage snapshot
(`test/model-map-lineage.test.js --update`), README routing table (`tools/gen-routing-doc.js`),
then `tools/check-pinned-model-ids.js` and a `git diff --stat`. The human intent-gate stays:
`regen` rebuilds, the human inspects the diff and confirms it is the *intended* change (e.g. only
an `opus-4-7`→`opus-4-8` bump, no null/route-drop transitions) before committing.

Honest scope — 2 of 3 derived artifacts regenerate. `test/resolve-capability.test.js` §11 has no
generator: its `want:` pins are hand-authored intent, not derived data. `check-pinned-model-ids.js`
self-reports staleness instead — it flags any pinned id that no longer appears in
`config/model-map.json#model_routes` (literal key or `re:` pattern, all providers) with a
"hand-update these lines" warning.

## Future (TODO — not built)

- **Tier 3 — upstream-catalog deprecation watch.** Extend
  `tools/c-thru-benchmarks-update.sh`'s debounced-fetch + SIGHUP scaffold to poll the live model
  catalog and **flag** when a model pinned in `config/model-map.json` (e.g. `claude-opus-4-7`)
  disappears upstream. Turns "a snapshot broke mysteriously" into a proactive deprecation warning at
  the source, before the next config edit propagates the drift.

### Upstream watch — claude-code#44385 (Agent tool ignores frontmatter `model:`)

`tools/c-thru-agent-router-hook.sh`'s Agent-tool branch exists **only** because of
[claude-code#44385](https://github.com/anthropics/claude-code/issues/44385): the Agent tool
ignores the `model:` field in agent frontmatter, so the PreToolUse hook rewrites
`subagent_type` → `agent_to_capability` → injects `model` into `updatedInput`.

**Retirement condition:** when #44385 ships upstream, frontmatter `model:` suffices and the
hook's model-injection branch becomes dead weight *and* a double-override risk (two paths
setting the model can disagree). At that point retire the Agent-tool model-injection branch —
keep the observability logging and the WebSearch/WebFetch/Monitor/Plan passthrough untouched.
A matching comment sits at the top of the hook script.
