# c-thru Functionality Verification

**Current verification model:** 2026-07-27

This document explains what evidence is required before calling functionality covered. It is the
interpretation layer between the requirements in
[`functionality-map.md`](functionality-map.md), the implementation, and the current executable
test registry in `test/run-all.sh`.

`test/run-all.sh` is the source of truth for what executes. `test/run-all-coverage.test.js`
fails when a runnable test artifact is neither registered there nor explicitly excluded.
Registration is necessary, but it is not proof that the assertions exercise the advertised
behavior.

## Evidence layers

| Layer | What it proves | Blocking surface | What it does **not** prove |
|---|---|---|---|
| **Structural registration** | Test files are reachable from the runner, exit codes are fail-closed, live gates are wired, and intentional exclusions are named. | `run-all-coverage`, `exit-code-gating`, `gate-coverage`, and `live-suite-wiring` | That a registered assertion drives the real semantic branch or would catch the claimed regression. |
| **Deterministic semantics** | Hermetic fixtures and stub providers reproducibly exercise implementation behavior, error paths, cleanup, and wire shapes. | `make test` | Current upstream availability, credentials, billing, vendor CLI drift, or probabilistic model quality. |
| **Live integrity** | Real provider and pinned-Claude-Code contracts still work with configured credentials and prerequisites. Missing requested coverage is `BLOCKED`/`SKIPPED`, not green. | `make test-live-shard SHARD=provider` and `SHARD=agent` | Broad deterministic coverage or a permanent claim about model-selection quality. |
| **Stochastic quality** | Model-backed judges, agent contracts, hierarchy, and offload scorecards meet their defined thresholds for that run and retained evidence. | Pinned agent shard; repeated evidence when a decision depends on stability | Determinism. A single green sample cannot establish a timeless quality guarantee. |

The scheduled workflow keeps these concerns separate:

- Blocking `provider` and `agent` live shards run on Ubuntu against Claude Code `2.1.220`.
- An `agent` canary against Claude Code `latest` is advisory, so early drift is visible without
  making a moving target the only blocker.
- A macOS hermetic lane runs `make test` once for platform-specific shell and filesystem behavior.
  The live shards do not duplicate that full deterministic registry.

Every scheduled test command and the shard, artifact-pilot, and compatibility live Make
entrypoints use `C_THRU_TEST_TIMEOUT_SECONDS=3300`. Scheduled jobs have a separate 70-minute
lifecycle ceiling, leaving 15 minutes around the 55-minute test command for setup, owned-process
cleanup, evidence finalization, and artifact upload. No individual test command may consume that
lifecycle reserve.

## Current executable registry

Add or remove runnable coverage in `test/run-all.sh`, not in this document. Then run:

```bash
node test/run-all-coverage.test.js
node test/exit-code-gating.test.js
node test/gate-coverage.test.js
node test/live-suite-wiring.test.js
```

Those checks establish structural reachability. For semantic evidence, run the narrow regression
test first and then `make test`. Live integrity is opt-in and credential-bearing:

```bash
C_THRU_TEST_EVIDENCE_PATH=/absolute/path/provider-evidence.json \
  make test-live-shard SHARD=provider

C_THRU_TEST_EVIDENCE_PATH=/absolute/path/agent-evidence.json \
  make test-live-shard SHARD=agent
```

`make test-live-all` remains a strict, capped local compatibility aggregate. Scheduled CI uses
the two disjoint shard commands so failures and retries remain attributable.

## Real artifact selection pilot

`offload-artifact-fixtures.test.js` deterministically validates the six generated inputs: two
decompressible PNGs, two structurally valid PDFs, a multi-file log corpus above 50K
token-equivalent with one request-id needle, and a 200-page-marker specification above 50K
token-equivalent. Each real-session fixture receives only its own `0600` files inside its
launcher-owned disposable working directory.

The model-backed selection lane is intentionally manual while its cost and variance are
unmeasured:

```bash
C_THRU_TEST_EVIDENCE_PATH=/absolute/path/artifact-run.json \
C_THRU_OFFLOAD_EVIDENCE_PATH=/absolute/path/artifact-scorecard.json \
  make test-live-artifacts
```

The target selects exactly those six cases and pins `CLAUDE_LLM_MODE=best-cloud` plus
`CLAUDE_LLM_PROFILE=32gb`, so host RAM cannot silently route multimodal cases to a different
16gb cell. Invocation, completed-child, cleanup, and correlated proxy-route proofs are blocking;
the noisy one-run agent-choice threshold is advisory. Promotion to scheduled or blocking status
requires at least three comparable baseline and three comparable candidate campaign artifacts.
The pooled evaluator rejects duplicate run IDs and drift in the Claude version, model map,
selection corpus, threshold, or fixture contract, while recording the distinct baseline and
candidate agent-description hashes. The sanitized `c-thru.agent-offload` schema v2 also records
requested and effective LLM mode/profile, the stable parent launch route/model/backend when it can
be established, a map-bound route/config identity digest, and per-fixture sanitized child-dispatch
observations. Pooled comparisons reject drift in the stable parent execution coordinates and in
the observed route identity for the same fixture and selected specialist. Every selected
specialist in a route-proved fixture must have a complete matching child-dispatch observation.
A `route_proof_failed` record may retain its sanitized Agent-tool selection while honestly
recording no matching dispatch; its failed integrity and `not_evaluated` quality state prevent it
from entering pooled scoring. A specialist's selection-dependent absence does not itself make
cohorts incomparable.

Boundary: this lane proves that real artifacts are present and that the selected specialist
completed through the correlated route. It does not yet make artifact-content accuracy blocking;
the stable facts embedded in each generated input are available for a future advisory semantic
proof after the selection pilot is stable.

## Six artifact-bearing exclusions

After excluding the registry itself and the three canonical harness helpers (`helpers.js`,
`helpers.sh`, and `offload-artifact-fixtures.js`), six source artifacts under `test/` are
intentionally not direct registered suites. The new artifact helper is covered by the registered
`offload-artifact-fixtures.test.js`; its presence alone is not executable coverage.

| Artifact | Registry disposition | Coverage consequence |
|---|---|---|
| `agent-contract-fixtures.js` | Shared current-agent roster/parser library, imported by registered suites. | Its callers cover selected behavior; it has no standalone suite result. |
| `provider-live-prerequisites.js` | Shared live credential/billing/quota classifier, imported by provider suites. | Its callers cover selected behavior; it has no standalone suite result. |
| `agent-prompt-unit.js` | Manual CLI driver, allowlisted by the registry-completeness check. | Useful for manual probing, but not blocking coverage by itself. |
| `benchmark-coverage.test.js` | Explicitly excluded because its current mode fixture checks zero cells. | Its assertions contribute no release evidence until the fixture is populated and registered. |
| `proxy-autodetect.test.sh` | Explicitly excluded because it depends on host RAM; the hermetic `.js` variant is registered. | Only the registered JavaScript variant contributes automated autodetect evidence. |
| `proxy-targets.test.js` | Explicitly excluded because the `targets{}` request-defaults feature is not implemented. | Neither the feature nor this dormant test is covered by a green aggregate. |

Any change to this list must update the executable registry and
`test/run-all-coverage.test.js` together. Converting an exclusion into coverage means making the
artifact deterministic enough to run, registering its canonical path, and proving its assertions
fail against the missing/broken behavior before claiming the gap closed.

## Evidence and verdict rules

When `C_THRU_TEST_EVIDENCE_PATH` is set, `test/run-all.sh` writes the aggregate's
machine-readable evidence to that unique path. Agent campaigns additionally emit a sanitized
`c-thru.agent-offload` scorecard, excluding prompts, raw responses, transcripts, tokens, and
credentials. Scheduled CI uploads both documents with `if: always()`.

Failure-only `c-thru-runall-*` logs are not sanitized evidence: they preserve raw child output
for diagnosis and may contain provider responses or credential-shaped text. The runner allocates
the directory exclusively as `0700` under an owner-controlled or sticky resolved `TMPDIR` and
publishes collision-safe `0600` files without replacing pre-existing files or following
symlinks. Each CI lane supplies and uploads only its exact current-run directory, with one-day
retention, when the repository is private. Public repositories do not upload these raw logs.
Artifact upload leaves the private runner-filesystem boundary and inherits the repository's
Actions-artifact access boundary; do not redistribute these logs or use them as credential-safe
evidence.

Use these verdict rules:

1. A file being registered proves reachability only.
2. A green hermetic suite supports deterministic semantic claims only for the branches its
   assertions actually drive.
3. A green live shard supports current integration integrity only for the providers and agent
   contracts recorded in that run's evidence.
4. A stochastic quality claim needs its threshold, sample conditions, and retained evidence;
   repeat runs when variance could change the decision.
5. A skipped or blocked requested live contract is not passing coverage.
6. An excluded artifact is not coverage, even if its source contains assertions.

## Abstraction change trace

An extraction or consolidation is complete only when its feature inventory remains traceable
across the old boundary, the new canonical owner, its adapter, and executable verification.
Record at least: inputs, outputs, exit/error behavior, side effects that stay outside the
abstraction, delivery copies, before/after production LOC, focused tests, aggregate registration,
and any intentionally different caller policy.

### AR-001: launcher model-route consolidation

| Contract | Before | Canonical owner after | Executable trace |
|---|---|---|---|
| Exact key before patterns; first pattern wins | Bash lookup in `tools/c-thru` | Still the thin Bash selector; this preserves Bash ERE and glob syntax | Exact, malformed/POSIX regex, and full Bash-glob grammar cases in `test/model-route-parity.test.sh` |
| Nested `re:` matching | jq/Oniguruma in the launcher | Injected `regexTest` policy at the JS graph boundary; proxy callers keep JavaScript RegExp behavior | Nested POSIX-class regex golden case |
| Mode target order: requested → `connected` → `default` → first value | Bash/jq `pick_mode_target` | `model-map-resolve.js:pickModeTarget` | Golden mode cases in the same test |
| `{endpoint,name}`, `model@backend`, and nested route names | Bash/jq `resolve_target` | `model-map-resolve.js:resolveRouteTarget` | Alias, sigil, and nested golden cases |
| Launcher depth guard | Depth greater than 8 rejected | Target adapter passes `maxDepth: 9`, preserving eight nested hops | 7/8-hop positive and 9-hop negative cases |
| Unmatched, cycle, or missing endpoint | Shell status 0 with empty stdout | Selector skips the adapter when unmatched; unresolved selected target exits 2 and the shell maps it to empty success | Status, stdout, and stderr assertions |
| Malformed config / missing adapter | jq or helper failure | CLI/adapter operational error | Exit 1 plus diagnostic assertions |
| Backend lookup, auth bootstrap, proxy/Ollama startup, env mutation | Bash launcher | Still Bash launcher | Launcher E2E suites; no side effect moved into the resolver |

The pre-change executable surface was 6,915 lines across `tools/c-thru`,
`tools/c-thru-resolve`, and `tools/model-map-resolve.js`. AR-001 reduces that physical production
surface to 6,901 lines (`-14` net), including a 66-line reduction in the launcher. The larger
golden test is deliberate:
it replaces a stdout-only parity check that could treat two unresolved/crashed implementations
as equivalent. `test/c-thru-target-launch.test.js` also drives the real entrypoint with a
Bash-ERE-only pattern, proving the selector/adapter wiring rather than only a sourced helper.

## Historical audit

[`test-coverage-audit.md`](test-coverage-audit.md) is the April 26, 2026 point-in-time audit. It
is retained for provenance, but this document and the executable registry supersede its counts,
line numbers, and open-gap verdicts. Re-verify implementation source and current tests before
reusing any historical finding.
