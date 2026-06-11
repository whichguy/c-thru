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

`gen-routing-doc.js` pins `c-thru-explain.js` to the repo `config/model-map.json` via
`CLAUDE_MODEL_MAP_PATH` so generation is deterministic (never reads the runtime
`~/.claude/model-map.json`). The table lives between sentinel markers in `README.md`
(`<!-- BEGIN routing-table … -->` … `<!-- END routing-table -->`); everything outside the markers is
hand-maintained prose.

A second derived surface — the `agents/*.md` roster and dispatch graph in
[`docs/agent-architecture.md`](agent-architecture.md) — is kept honest at test time instead of commit
time: `test/agent-dispatch-graph.test.js` (every `subagent_type` resolves agent→capability→model) and
`test/agent-mapping-complete.test.js` (every agent resolves to a live endpoint).

## Future (TODO — not built)

- **Tier 2 — `make regen`.** A single target that rebuilds the snapshot fixtures
  (`test/model-map-lineage.test.js --update`, `test/resolve-capability.test.js`) in one command, so a
  config bump no longer requires manual archaeology to find which assertions went stale. Keep the
  human intent-gate: `regen` rebuilds, the human inspects the diff and confirms it is the *intended*
  change (e.g. only an `opus-4-7`→`opus-4-8` bump, no null/route-drop transitions) before committing.
- **Tier 3 — upstream-catalog deprecation watch.** Extend
  `tools/c-thru-benchmarks-update.sh`'s debounced-fetch + SIGHUP scaffold to poll the live model
  catalog and **flag** when a model pinned in `config/model-map.json` (e.g. `claude-opus-4-7`)
  disappears upstream. Turns "a snapshot broke mysteriously" into a proactive deprecation warning at
  the source, before the next config edit propagates the drift.
