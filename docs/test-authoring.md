# Writing a test here

This doc is the mechanical HOW: suite conventions, registration, the exit-code contract. For
the current coverage model and known executable exclusions, see
`docs/functionality-verification.md`. The exact executable registry is `test/run-all.sh`, guarded
by `test/run-all-coverage.test.js`. `docs/test-coverage-audit.md` is an April 2026 historical
snapshot; do not use its counts, line numbers, or gap list as current state.

## Suite types

- **Node** (`test/*.test.js`) — the default for anything touching `tools/*.js` or
  `tools/claude-proxy`. Stdlib only, no external deps (matches the whole repo's "No External
  Node Dependencies" constraint — see `CLAUDE.md`).
- **Bash** (`test/*.test.sh`) — for shell-script behavior (hooks, `install.sh`, `c-thru`
  subcommands) where driving the real script end-to-end is more direct than reimplementing its
  logic in Node.
- Shared harness: `test/helpers.js` (Node — `assert`/`assertEq`/`summary`/`spawnProxy`/
  `withProxy`/`startStubServer`/`spawnCapture`/`getFreePort`, and more) and `test/helpers.sh`
  (bash equivalents). Reach for these before writing your own — most new test files this project
  has written recently import 3-6 helpers rather than reinventing spawn/assert/cleanup logic.

## The exit-code contract (mandatory)

`test/run-all.sh` keys **purely on each suite's process exit code** — it doesn't parse output for
"FAILED" text. Every suite must therefore wire its exit code to its actual failure count:

```js
const failed = summary();
process.exit(failed > 0 ? 1 : 0);
```

This isn't stylistic. The exact bug this contract prevents already happened once: a suite ended
its `main()` with a bare `summary();` call (return value discarded), then
`main().catch(err => process.exit(1))`. `summary()` doesn't throw on a failed assertion — it logs
"N FAILED" and returns the count. With the count discarded, `main()` resolved normally, the
`catch` never fired, and the process exited 0 despite failed assertions. `run-all.sh` saw exit 0
and marked the whole suite green. `test/exit-code-gating.test.js` is a meta-lint that fails the
build if any `test/*.test.js` doesn't wire exit code to failure count (via `summary()` +
`process.exit`, an explicit exit-code guard, or a fail-fast helper) — it must stay green, and a
new suite that trips it needs the same fix idiom, not an allowlist entry (the allowlist is for
genuinely different harness shapes, not for skipping the gate).

Bash suites: the equivalent is `[ "$FAIL" -eq 0 ]` (or `[[ ]]`) as the script's final statement —
bash's own exit-code-of-last-command semantics do the rest.

## Registering a new suite

**New test files are not auto-discovered.** `test/run-all.sh` invokes every suite by an explicit
`run_suite "<label>" <command...>` line — a new file with no matching line simply never runs,
silently. `test/run-all-coverage.test.js` guards this (checks every `test/*.test.{js,sh}` file
has a corresponding invocation), but don't rely on that guard catching it after the fact — add the
line when you add the file:

```bash
run_suite "my-new-thing (one-line description of what it covers)" \
  node "$REPO_DIR/test/my-new-thing.test.js"
```

Place it near thematically related suites (grep `run-all.sh` for a sibling area first). A live
suite must also be assigned to the `provider` or `agent` shard in `test/run-all.sh` and have its
gate exported by `make test-live-shard SHARD=<provider|agent>`. `make test-live-all` remains a
local compatibility aggregate; scheduled CI uses the disjoint shards and must not rerun the full
deterministic registry.

### OSS brand-leaf identity (opt-in live)

Fleet/OSS pin + identity + proxy-lifecycle probe:

```sh
make test-live-oss-brand
# or: C_THRU_LIVE_OSS_BRAND=1 C_THRU_LIVE_SHARD=agent bash test/run-all.sh
```

Driver: `test/c-thru-brand-identity-live.sh` (`MODE=direct` backend pins; `MODE=print` independent
`c-thru -p` with prompt on STDIN, `C_THRU_KEEP_PROXY=0`, journal proof, identity gate).
Ship agents default: `deepseek qwen kimi glm`. Hermetic pins live in
`test/brand-identity-unit.test.js` and `test/c-thru-upstream-url.test.js` (always on in `make test`).

### Live-provider outcome contract

Every child registered through `run_live_suite` must emit exactly one terminal line:

```text
C_THRU_LIVE_OUTCOME|provider=<provider>|suite=<suite>|status=<passed|skipped|blocked|failed>|reason=<delimiter-safe-reason>
```

The provider and suite fields must match the runner registration, and the status must agree with
the process exit. Missing, duplicate, mismatched, or exit-incoherent markers are harness failures.
Use `blocked` for credentials, quota, billing, or another external prerequisite; use `skipped`
only when a mandatory advertised contract was not exercised. Trigger-dependent probes are
opportunistic: their absence may be reported in human output, but does not turn an otherwise
complete child into a mandatory skip. `C_THRU_STRICT_LIVE_PROVIDERS=1` makes both blocked and
mandatory-skipped requested suites fail the aggregate; both live-shard targets and the local
compatibility aggregate enable that strict mode.

Every suite launched by `test/run-all.sh` runs in its own supervised process group and has a
hard wall-clock ceiling controlled by `C_THRU_TEST_TIMEOUT_SECONDS` (default and maximum:
3,600 seconds). The aggregate `run-all.sh` command is self-supervised by the same deadline, so
lock acquisition and cumulative suite execution cannot make the command appear hung beyond an
hour. Directly runnable model-backed JavaScript suites must call
`ensureModelTestSupervisor()`; shell entrypoints must self-exec through
`tools/run-with-hard-timeout.js`. Register either pattern in `live-suite-wiring.test.js`.
Scheduled workflow commands and the `test-live-shard`, `test-live-artifacts`, and
`test-live-all` Make entrypoints use a narrower 3,300-second cap. Scheduled jobs place that
55-minute test command inside a 70-minute lifecycle, reserving 15 minutes for setup, cleanup, and
artifact upload. The test-command cap is unchanged; the extra lifecycle reserve does not
authorize a longer individual test.

Individual model operations also use `C_THRU_MODEL_TEST_TIMEOUT_MS`, which defaults to and may
not exceed 3,600,000 ms. Keep narrower timeouts in hermetic tests that deliberately exercise
timeout behavior. Any suite, model, or harness override above one hour is a configuration error.

When `C_THRU_TEST_EVIDENCE_PATH` is set, the aggregate must write its machine-readable evidence
there even on a non-green result. Give concurrent shards distinct paths. Model-backed offload
campaigns additionally write the sanitized scorecard named by `C_THRU_OFFLOAD_EVIDENCE_PATH`
(or a printed private temporary path when omitted). Scheduled agent jobs upload both evidence
documents with `if: always()`. Scorecard schema v2 records requested/effective mode and profile,
stable parent launch route/model/backend identity, a map-bound route/config digest, and sanitized
per-fixture child-dispatch observations. Pooled comparisons require the stable parent execution
coordinates and the observed route identity for each repeated fixture/selected-specialist pair to
match. A route-proved fixture is rejected unless every selected specialist has a complete matching
child-dispatch observation. A failed-proof fixture may retain an unproved selection only with
failed integrity and `quality_status=not_evaluated`; selection-dependent absence alone is not
treated as environment drift.

Detailed failure logs have a stricter boundary because they contain raw, unsanitized child
output. `run-all.sh` requires an owner-controlled or sticky resolved `TMPDIR`, creates a unique
`0700` directory beneath it, creates each log as `0600`, and refuses pre-existing directory or
file/symlink targets. CI sets
`C_THRU_TEST_FAILURE_LOG_DIR` to one exact, non-existing `c-thru-runall-*` child of
`runner.temp`; the failure-only upload names only that path, never a temp-directory glob, and
retains it for one day. The upload is disabled unless the repository is private; public
repositories leave the raw directory on the ephemeral runner only. Uploading moves the data from
private runner filesystem permissions into the repository's Actions-artifact access boundary,
so these artifacts are diagnostic material, not sanitized evidence, and must not be shared as if
they were credential-safe.

The six image/PDF/oversized-context selection cases use generated inputs rather than prompt-only
stand-ins. Their deterministic generator test runs in `make test`; the paid/model-backed pilot is
separate:

```bash
C_THRU_TEST_EVIDENCE_PATH=/absolute/path/artifact-run.json \
C_THRU_OFFLOAD_EVIDENCE_PATH=/absolute/path/artifact-scorecard.json \
  make test-live-artifacts
```

That target pins `best-cloud` at `32gb`, selects only the six artifact cases, keeps one-run
quality advisory, and still treats missing artifacts, failed invocations, incomplete child
results, or unproved routes as integrity failures. Do not add this pilot to blocking scheduled CI
until at least three comparable baseline and three comparable candidate campaigns establish its
cost and variance.

## Sandbox-safe vs. proxy-spawning suites

Suites that call `spawnProxy`/`withProxy` bind a real loopback TCP listener. Some sandboxed
execution environments (documented in `AGENTS.md`) cannot bind loopback ports at all
(`listen EPERM`), independent of whether the code under test is correct. If you're running in
such an environment: **report the EPERM as a sandbox limitation, don't rework the test to avoid
binding a port** — that would trade a correct, standard test pattern for a worse one just to
dodge an environment quirk, and the next contributor running in a normal environment loses
nothing by the test staying as-is. Cite `AGENTS.md`'s existing note rather than re-deriving this
each time.

## Fixture conventions

- `fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-<suite-name>-'))` for scratch directories;
  clean up in a `finally` block (`fs.rmSync(dir, { recursive: true, force: true })`), not just at
  the happy-path end — a thrown assertion must not leak a temp dir.
  Bash equivalent: `mktemp -d "${TMPDIR:-/tmp}/c-thru-<suite-name>.XXXXXX"` +
  `trap 'rm -rf "$DIR"' EXIT`.
- Ports: use `getFreePort()` / bind-then-free (dynamic `:0`), never a hardcoded port — suites run
  concurrently across sessions sharing this working tree (see below).
- When a script under test reads `$HOME` (or `CLAUDE_CONFIG_DIR`/`CLAUDE_PROFILE_DIR`/
  `CLAUDE_DIR`), override **all** of them in the child's env, not just `$HOME` — a test run from
  inside a live c-thru session has these set in the ambient environment, and a partial scrub lets
  the real session's config leak into the test's sandbox (this exact gap in `spawnProxy` broke a
  suite's signal for an entire multi-round session before being found and fixed — see
  `docs/review-methodology.md` rule 1).

## Regression-test pattern

When fixing a bug found during a review round: write the test, **confirm it fails against the
pre-fix code**, then apply the fix and confirm it passes. A test written and only ever run against
already-fixed code doesn't prove it would have caught the bug — this project's Phase 4 discipline
(`docs/review-methodology.md`) requires the fail-then-pass check specifically because "I wrote an
assertion that's true" and "I wrote an assertion that would have caught the actual bug" are not
the same claim.

## Concurrency and locking

Per `CLAUDE.md`'s "Concurrent sessions" note: `make test` (hermetic / `--skip-smoke`) is safe to
run concurrently across sessions (unit/proxy tests bind random free ports, no shared fixed state)
— prefer it while iterating. A full `make test-all` / `test/run-all.sh` run takes an exclusive
`mkdir`-based lock for its whole duration, because the e2e/smoke suites talk to a real Ollama
instance and can cross-fail under contention; a second concurrent full run queues rather than
racing. Don't add a suite that assumes it has the machine to itself unless it's already behind
the full-run-only gate.
