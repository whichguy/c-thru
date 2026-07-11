# Writing a test here

This doc is the mechanical HOW: suite conventions, registration, the exit-code contract. For
WHAT'S currently untested, see `docs/test-coverage-audit.md` — a coverage-gap tracker, a
different axis from this doc, consulted independently of it (you might write a test here for a
brand-new feature that audit never mentions).

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

Place it near thematically related suites (grep `run-all.sh` for a sibling area first). Suites
gated behind a live/opt-in env var (`C_THRU_LIVE_ANTHROPIC=1`, `C_THRU_DESTRUCTIVE_TESTS=1`, etc.)
also need a `Makefile` `test-live-all` entry so the opt-in flag actually gets exported for a full
live run.

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

Per `CLAUDE.md`'s "Concurrent sessions" note: `make test-fast` is safe to run concurrently across
sessions (unit/proxy tests bind random free ports, no shared fixed state) — prefer it while
iterating. A full `test/run-all.sh` (no `--fast`) run takes an exclusive `mkdir`-based lock for
its whole duration, because the e2e/smoke suites talk to a real Ollama instance and can cross-fail
under contention; a second concurrent full run queues rather than racing. Don't add a suite that
assumes it has the machine to itself unless it's already behind the full-run-only gate.
