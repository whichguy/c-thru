# Getting started as a c-thru contributor

This guide walks a brand-new contributor from an empty checkout to "I made a
change and the tests pass." It is the *path* through the material; the
[`README.md`](../README.md) is the *map*. Where the README already has a table
or a reference section, this guide links to it instead of restating it, so the
two documents don't drift apart.

Read this top to bottom the first time. After that, jump to the section you
need — each one is self-contained enough to revisit.

---

## 1. What c-thru is, in one breath

**c-thru is a router and proxy that sits between an unmodified Claude Code
binary and the model backend(s) you actually want to talk to.** Claude Code
speaks the Anthropic Messages API and assumes it is talking to Anthropic.
c-thru intercepts that conversation, picks a concrete model based on what the
request is *for* and how much machine you have, translates the wire format
when the backend isn't Anthropic-native, and forwards everything else
verbatim. One session can run a planner against cloud Sonnet and a coder
against a local Qwen3.6, with no change to the `claude` binary.

Two components do all the work, and both live in `tools/`:

- **`tools/c-thru`** — a bash entrypoint (the largest file in the repo). It
  selects a model-map, decides whether a proxy is needed, spawns it, injects
  the ephemeral session control plane, and execs the real `claude`.
- **`tools/claude-proxy`** — a long-running Node.js HTTP server. It resolves
  capability aliases to concrete models, rewrites auth headers and URLs,
  translates Anthropic ↔ Gemini and OpenAI-compatible Responses (OpenAI/xAI),
  forwards Ollama via `/v1/messages`, and passes everything else through. It
  depends on **Node stdlib only** — no runtime `package.json` / `node_modules`
  for the proxy (stdlib-only constraint).

Why does this layer exist at all? Three reasons worth internalizing before
you touch code, because they explain almost every design choice you'll meet:

1. **Cost.** Routing bulk coding work to OSS cloud models (DeepSeek, Kimi, GLM
   via OpenRouter) and reserving Anthropic for the hard tiers keeps a session
   productive without burning API budget on every trivial call.
2. **Sovereignty.** A fully-local `best-local-oss` mode runs everything on
   Ollama with no cloud egress, and the `best-cloud-gov` / `best-local-gov`
   modes filter out Chinese-origin models for compliance work. The router is
   the place where that policy lives, instead of being smeared across every
   consumer of the API.
3. **Hardware-tiered model selection.** The same config resolves to different
   concrete models on a 16 GB laptop versus a 128 GB workstation. The proxy
   reads `os.totalmem()` (overridable), picks a tier, and the capability table
   picks the model for that tier — so a contributor on a small machine and a
   reviewer on a big one are exercising the same code paths against different
   weights.

Keep these three in mind. When a design choice looks baroque, it's almost
always serving one of them.

---

## 2. Prerequisites

You need `node`, `jq`, and `curl` on PATH. `node` must be version 15 or
higher (the proxy uses modern stdlib). `ollama` is optional — you only need
it if you want to exercise local routing modes (`best-local-oss`,
`best-local-gov`) or run the smoke/e2e suites.

A note on platform: c-thru is macOS-first. It works on Linux (the proxy is
portable Node, the bash is portable bash), and the test suite runs in CI, but
the `check-deps --fix` path and some of the Ollama lifecycle assumptions are
macOS-shaped. If you're on Linux, expect to install dependencies through your
own package manager and to run Ollama as a system daemon rather than relying
on the autostart convenience path.

After you clone (next section), run the dependency auditor from the repo so
you do not need a pre-installed `c-thru` on PATH:

```bash
bash tools/c-thru check-deps
# macOS optional auto-fix:
bash tools/c-thru check-deps --fix
```

---

## 3. First run

**End users (Shape C):** install the private marketplace plugin, run
`/c-thru:install-cli` to bootstrap CLI tools (not SessionStart clone), then
always launch with **`cthru`**. See the root
[`README.md`](../README.md) Quick start.

**Contributors** clone the repo and run the same installer core from a checkout:

```bash
git clone https://github.com/whichguy/c-thru.git
cd c-thru
bash tools/c-thru check-deps
bash install.sh
cthru
```

(`install.sh` is invoked with `bash` so a fresh checkout works without a git
executable bit.) Plugin bootstrap and `install.sh` share
`tools/c-thru-install-core.sh` (symlinks + stamp under `~/.claude/`).

`install.sh` is idempotent and safe to re-run. It does three things you
should understand, because they explain where c-thru's state lives
afterward:

1. **Symlinks a curated executable list from `tools/` into
   `~/.claude/tools/`.** Install does not necessarily symlink every file under
   `tools/`. Edits in the repo still show up through those symlinks. `c-thru`
   and `cthru` are both linked (identical entrypoint; `cthru` is a convenience
   alias).
2. **Seeds the model-map.** It copies `config/model-map.json` to
   `~/.claude/model-map.system.json` (the shipped defaults, overwritten on
   every install) and creates an empty `~/.claude/model-map.overrides.json`
   if one doesn't exist (your customizations — never touched on upgrade). The
   effective `~/.claude/model-map.json` is regenerated by the proxy on
   startup by merging system + overrides.
3. **Adds `~/.claude/tools` to your PATH** via your shell rc file (zshrc,
   bashrc, or fish config), idempotently. Open a new shell or `source` the rc
   file afterward.

The installer ends with a post-install end-to-end validation that actually
boots the proxy and pings it — watch for the `E2E checks:` block. If it
prints green `[ok]` lines through `proxy boot`, you're installed.

To reverse the install later (user overrides preserved):

```bash
bash uninstall.sh --dry-run
bash uninstall.sh
```

Now verify with the exact commands from the "Install and Verify" block in
[`CLAUDE.md`](../CLAUDE.md):

```bash
bash -n tools/c-thru             # bash syntax check
node --check tools/claude-proxy  # node syntax check
node --check tools/model-map-*.js tools/llm-capabilities-mcp.js
node tools/model-map-validate.js config/model-map.json   # validate shipped config
node test/model-map-v12-adapter.test.js                  # adapter regression test
bash test/c-thru-bootstrap-auth-env.test.sh              # interactive auth bootstrap (TTY-mocked)
~/.claude/tools/c-thru list      # runtime smoke-test (requires install; --list also accepted)
```

The happy path: every command exits 0, `model-map-validate.js` prints nothing
(errors only), the adapter test prints a `175 tests: 175 passed, 0 failed`
summary, and `c-thru list` shows your active hardware profile, the configured
routes, and any local Ollama models it can see.

Two common failure modes are worth knowing on day one, because both look
scarier than they are:

- **Proxy not reachable.** If `c-thru list` reports the proxy is down or the
  model-map is missing, run `/c-thru-status fix` from a Claude session (or
  `c-thru restart` from the shell). The `fix` path applies recommended
  mappings and reloads. A stuck proxy can be killed outright with
  `pkill -f claude-proxy` — it's a child of `c-thru`, so it always respawns
  on the next launch.
- **Ollama unreachable.** `C_THRU_OLLAMA_AUTOSTART` defaults to `1`, so when
  Ollama is unreachable `c-thru` runs `nohup ollama serve` in a detached
  subprocess and retries once. If you'd rather manage Ollama yourself (the
  recommended path on macOS is the Ollama app or `launchctl`), set
  `C_THRU_OLLAMA_AUTOSTART=0`. The proxy never spawns or kills Ollama itself
  — that boundary is `c-thru`'s responsibility, not the proxy's.

If you see TUI garble or "broken keys" once you're inside a session, that's a
known class of issue with its own troubleshooting doc — see
[`docs/tui-troubleshooting.md`](tui-troubleshooting.md). Don't chase it as a
keystroke problem; it isn't one.

---

## 4. The mental model: how a request flows

When you run `c-thru` (or `cthru`), here is the story of one request, in
order:

1. **Resolve the model-map and route.** `c-thru` picks a model-map by
   precedence (`CLAUDE_MODEL_MAP_PATH` → `$PWD/.claude/model-map.json` →
   `~/.claude/model-map.json`), reads the routing mode and hardware tier,
   and decides whether the chosen backend needs a proxy at all.
2. **Spawn the proxy.** If a proxy is needed (the common case — every backend
   routes through it unless `CLAUDE_PROXY_BYPASS=1` is set), `c-thru` starts
   `claude-proxy` on a dynamically-selected port and coordinates via a
   FIFO `READY <port>` handshake so the router knows when it's safe to
   proceed.
3. **Inject the session control plane.** `c-thru` execs the real `claude`
   binary with three ephemeral injections: `ANTHROPIC_BASE_URL` pointed at
   the proxy, `--settings` (hooks + the `llm-capabilities` MCP server), and
   `--agents` (the fleet definitions from `agents/*.md`), plus an
   `--append-system-prompt` awareness block. These are *ephemeral* — they
   exist for this launch only and are never written to durable project
   settings.
4. **The proxy resolves each request.** When Claude Code sends a Messages
   API call, the proxy maps the request's logical capability to a concrete
   model. The resolution chain is:
   `agent-name → agent_to_capability → llm_profiles[capability][mode][tier] → concrete model`.
   So a `coder` agent call becomes the `coder` capability, which at
   `best-cloud` / `64gb` resolves to `gemini-pro` on the `gemini_ai`
   endpoint (per the generated routing table in the README). The proxy
   rewrites the model field, URL, and auth headers, translates the wire
   format if the backend needs it, and forwards.

That's the whole shape. The branchy version — native-subcommand bypass,
`--bypass-proxy`, the backend lookup ladder, FIFO handshake failure modes —
lives in [`docs/architecture-diagrams.md § 1`](architecture-diagrams.md#1-cli-launch--proxy-spawn--claude-exec).
Read that when you need the full picture; the short version above is enough
to orient you for your first change.

One thing to internalize now: **agent files are never edited when you remap
models.** An agent's `model:` frontmatter is a logical name; the proxy
resolves it through `agent_to_capability` and the capability table. Remapping
is a config change, not an agent-file change. This is the single most
important separation of concerns in the repo, and it's why section 6 below
is a one-line edit.

---

## 5. The layout you'll work in

The repo has a deliberately small surface area. Here is each directory and
*why* it exists, not just what's in it.

- **`tools/`** — the bash entrypoint (`c-thru`), the Node proxy
  (`claude-proxy`), and all the helpers, hooks, and validators. This is where
  almost all runtime code lives. The two-directory structure with `config/`
  is **required**: both `c-thru` and `claude-proxy` compute
  `ROUTER_REPO_ROOT` as `$(dirname $0)/..` and read
  `$ROUTER_REPO_ROOT/config/model-map.json`. Do not flatten it.
- **`config/model-map.json`** — the shipped defaults. Standard JSON (no
  comments — it's parsed with `JSON.parse`). This is the single source of
  truth for endpoints, routes, the capability table (`llm_profiles`), and the
  agent→capability map (`agent_to_capability`). Most model-routing changes
  are a one-value edit here.
- **`agents/*.md`** — the 27-agent fleet definitions. Each declares a
  logical `model:` name in frontmatter and a `description` (its only
  discovery surface). These are runtime-injected each `c-thru` launch via
  ephemeral `--agents` JSON — they are **not** installed into Claude's
  durable agent store. Edit them to change an agent's behavior or discovery
  text, never to remap its model.
- **`skills/`** — the agentic plan/wave system skills (`c-thru-plan`,
  `c-thru-config`, `c-thru-control`, etc.). Invoked via `/c-thru-plan`,
  `/cplan`, `/c-thru-config`. See [`docs/agent-architecture.md`](agent-architecture.md)
  for the wave lifecycle.
- **`docs/`** — the reference layer. Architecture diagrams, the
  endpoint × backend coverage matrix, env-var reference, headers reference,
  and the two process docs you'll meet in section 9 (`review-methodology.md`,
  `test-authoring.md`). When this guide says "link, don't restate," this is
  where it's pointing.
- **`test/`** — the suite. Node tests (`*.test.js`) and bash tests
  (`*.test.sh`), plus `run-all.sh` (the orchestrator) and shared harnesses
  (`helpers.js`, `helpers.sh`). New files are **not** auto-discovered; see
  section 8.
- **`plugins/c-thru/`** — the Claude Code plugin package. Listed by this
  repo's root marketplace (`.claude-plugin/marketplace.json`) and also by
  `claude-craft` as a git-subdir. It must mirror source files from `tools/`
  and `skills/`. After editing a mirrored source file, run
  `tools/sync-plugin-bundle.sh` to sync the bundle, and
  `tools/sync-plugin-bundle.sh --check` to verify. Bundle drift is also
  covered by the hermetic suite Validators (`make test` / `test/run-all.sh`).

---

## 6. Make your first change

The canonical first change is a model rebinding: swap one capability's model
for one mode × tier cell. It's a single value edit in
`config/model-map.json`, it exercises the reload path, and it doesn't touch
agent files — which is the whole point.

Suppose you want the `docs` capability to use `gemma4:31b` instead of
`gemma4:26b` at the `64gb` tier in `best-cloud` mode. Open
`config/model-map.json`, find `llm_profiles.docs["best-cloud"]["64gb"]`, and
change the value:

```json
"docs": {
  "best-cloud": {
    "16gb": "gemma4:e4b",
    "32gb": "gemma4:26b",
    "48gb": "gemma4:26b",
    "64gb": "gemma4:31b",
    "128gb": "gemma4:26b"
  },
  ...
}
```

Now apply it without restarting the session. `c-thru reload` sends `SIGHUP` to
the running proxy, derives the actual listening port from `lsof`, waits up
to 2s for `/ping` to confirm the proxy is alive, and prints the new tier:

```bash
c-thru reload
```

If the proxy isn't running or crashes on the new config, `reload` exits
non-zero — read errors keep the previous live config rather than crashing, so
a bad edit won't take down a running session.

Then verify the resolution chain without sending a real request:

```bash
c-thru explain --capability docs --mode best-cloud --tier 64gb
```

`explain` is pure JS — no proxy spawn — and prints the resolution chain for a
hypothetical request. You should see the chain end at `gemma4:31b` on the
`ollama_local` endpoint. (The `--agent <name>` form resolves through
`agent_to_capability` first, if you'd rather reason in agent terms.)

**One derived-artifact implication.** The README's "Agent routing reference"
table is *generated* from `config/model-map.json` by `tools/gen-routing-doc.js`.
Run `node tools/gen-routing-doc.js --check` (also part of `make test`) to
detect drift. After any config bump that touches the routing table, regenerate
it:

```bash
make docs
```

Review the diff — it should show only the model-id bump you intended, no
null/route-drop transitions. If you see something unexpected, that's the
signal your config edit meant something different than you thought. See
[`docs/derived-artifacts.md`](derived-artifacts.md) for the full self-update
pattern. For a deeper regen (lineage snapshot + README table + pinned-model
check), `make regen` does all three and shows the diff for your review.

---

## 7. Run the tests

Three targets cover the spectrum, and they are not interchangeable:

```bash
make check        # syntax checks (bash -n, node --check) + schema validation + contract check
make test         # hermetic suite (proxy + model-map; skip slow smoke) (~2 min)
make test-all     # full suite including smoke / long e2e
```

`make check` is the fast gate — it's what runs in seconds before you even
touch the proxy. `make test` is the everyday suite: hermetic, skips the slow
smoke and long e2e, and is **concurrent-safe** (the proxy unit tests bind
random free ports, so two sessions can run it at once without cross-failing).
This is the one to reach for while iterating.

`make test-all` is the full suite, and it is **not** concurrent-safe. The
full run takes an `mkdir`-based exclusive lock for its whole duration
because the e2e/smoke suites talk to a real Ollama instance and cross-fail
under contention (observed empirically — proxy-e2e times out, smoke exercises
the shared proxy lifecycle). A second concurrent full run queues rather than
racing. The practical version: don't run two `make test-all` invocations at
once on the same machine, and prefer `make test` for iteration.

For a single targeted test, invoke the file directly — `run-all.sh` keys
purely on each suite's process exit code, so a direct run gives you the same
signal as the full suite for that one file:

```bash
node test/model-map-v12-adapter.test.js     # adapter regression
node test/anthropic-api-coverage.test.js     # endpoint × backend coverage matrix
bash test/c-thru-bootstrap-auth-env.test.sh  # interactive auth bootstrap (TTY-mocked)
```

**Suite gates (run explicitly).** This repo does not require a local
`.githooks/` / `core.hooksPath` setup for contributors. The always-on gate is
the hermetic suite:

```bash
make test                    # or: bash test/run-all.sh --skip-smoke
```

That run includes drift **Validators** such as plugin-bundle sync check,
`gen-routing-doc.js --check`, diagram sync, and the agent/skill contract
check. Run pieces by hand when iterating:

```bash
node tools/gen-routing-doc.js --check
bash tools/sync-plugin-bundle.sh --check
bash tools/c-thru-contract-check.sh
```

---

## 8. Write your first test

The mechanical HOW of test authoring is documented in
[`docs/test-authoring.md`](test-authoring.md) — read it before writing your
first suite; this section is the orientation, not a substitute. Here is the
shape of a test in this repo, grounded in a real file.

Tests come in two flavors. **Node** (`test/*.test.js`) is the default for
anything touching `tools/*.js` or `tools/claude-proxy`. **Bash**
(`test/*.test.sh`) is for shell-script behavior where driving the real script
end-to-end is more direct than reimplementing its logic in Node. Both are
stdlib-only — no external deps, matching the whole repo's constraint.

The non-negotiable rule is the **exit-code contract**. `test/run-all.sh`
keys purely on each suite's process exit code; it does not parse output for
"FAILED" text. So every Node suite must wire its exit code to its actual
failure count, the way `test/model-map-v12-adapter.test.js` does at its tail:

```js
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

A bare `summary();` call with the return value discarded has bitten this
project before — the suite logged "N FAILED" and exited 0, and `run-all.sh`
marked it green. `test/exit-code-gating.test.js` is a meta-lint that fails
the build if any `test/*.test.js` doesn't wire exit code to failure count.
Don't add an allowlist entry; use the same fix idiom. For bash suites, the
equivalent is `[ "$FAIL" -eq 0 ]` as the script's final statement.

A minimal Node test skeleton consistent with the repo's conventions:

```js
#!/usr/bin/env node
'use strict';
// Tests for <thing>. Run with: node test/<thing>.test.js

const { assertEq, summary } = require('./helpers');   // shared harness

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++; }
  else      { console.error(`  FAIL  ${msg}`); failed++; }
}

console.log('<thing> tests\n');

// 1. <what this case proves>
{
  const got = /* ... exercise the code under test ... */;
  assert(got === 'expected', 'describes the invariant being checked');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

Reach for the shared harness (`test/helpers.js` for Node — `assert`/`assertEq`/
`summary`/`spawnProxy`/`withProxy`/`getFreePort`, and more; `test/helpers.sh`
for bash equivalents) before writing your own spawn/assert/cleanup logic.
Most new test files this project writes import three to six helpers rather
than reinventing them. Two fixture conventions that bit past contributors:
use `getFreePort()` or bind-then-free (dynamic `:0`), **never** a hardcoded
port — suites run concurrently across sessions sharing this working tree; and
when a script under test reads `$HOME` (or `CLAUDE_CONFIG_DIR` /
`CLAUDE_PROFILE_DIR` / `CLAUDE_DIR`), override **all** of them in the child's
env, not just `$HOME` — a partial scrub lets a live c-thru session's config
leak into your sandbox.

**Registration is manual.** New test files are not auto-discovered.
`test/run-all.sh` invokes every suite by an explicit `run_suite "<label>"`
line, and a file with no matching line simply never runs — silently. Add the
line when you add the file, placed near thematically related suites:

```bash
run_suite "my-new-thing (one-line description of what it covers)" \
  node "$REPO_DIR/test/my-new-thing.test.js"
```

`test/run-all-coverage.test.js` guards this (it checks every
`test/*.test.{js,sh}` file has a corresponding invocation), but don't rely on
the guard catching it after the fact. If your suite is gated behind a live or
opt-in env var (`C_THRU_LIVE_ANTHROPIC=1`, `C_THRU_DESTRUCTIVE_TESTS=1`,
etc.), it also needs a `Makefile` `test-live-all` entry so the opt-in flag
actually gets exported for a full live run.

When you're writing a regression test for a bug you just fixed, follow the
Phase 4 discipline from [`docs/review-methodology.md`](review-methodology.md):
write the test, **confirm it fails against the pre-fix code**, then apply
the fix and confirm it passes. A test written and only ever run against
already-fixed code doesn't prove it would have caught the bug.

---

## 9. Contributor invariants (the sharp edges)

These are the things that bite. They're presented as "here's why we're
careful," not a scolding list — each one exists because a past session lost
real work or produced a silent drift the hard way.

**Stage explicit paths only.** Multiple Claude sessions may share this
working tree. A broad `git add -A`, `git add -u`, `git add .`, or any
wildcard add silently stages another session's uncommitted WIP — a past
session needed a soft-reset salvage after exactly this. The equivalent
danger at commit time: if another session already has files staged, a plain
`git commit` (no pathspec) sweeps those in too. Commit with explicit paths:

```bash
git commit -m "..." -- tools/claude-proxy config/model-map.json
```

This builds the commit from only the named paths and leaves any other
already-staged index entries untouched. If your changes are line-interleaved
with another session's in the same shared file (both editing the same
declaration or argv line), don't try to surgically separate them — wait for
the other session to commit first, or commit the file's full current state
with a message that's explicit about which parts are yours.

**Don't commit unless asked.** This applies to every worker reading
`CLAUDE.md`, including delegated sessions that don't inherit
interactive-harness defaults. Make the change, run the tests, leave the
commit to the human.

**The `tools/` + `config/` two-directory structure is required.** Both
`c-thru` and `claude-proxy` compute `ROUTER_REPO_ROOT` as `$(dirname $0)/..`
and read `$ROUTER_REPO_ROOT/config/model-map.json`. Flattening the layout
breaks both at runtime. Don't.

**No external Node dependencies.** `claude-proxy`, `llm-capabilities-mcp.js`,
and all the `model-map-*.js` helpers use Node stdlib only. There is no
`package.json` and no `node_modules/`. Do not add third-party deps — the
zero-dep constraint is a feature (portability, no supply chain), not an
oversight.

**`exec` silently skips EXIT traps.** In bash, `exec <cmd>` replaces the
current shell process and never fires the `trap ... EXIT` handler. Any path
in `c-thru` that `exec`s into the real `claude` binary must ensure proxy
cleanup is complete beforehand. The guard (`if [[ -z "${PROXY_STARTED_PID:-}" ]]`)
enforces this: `exec` is only used when this shell did not start the proxy.
Do not add new `exec` calls in `c-thru` without verifying no proxy PID is
live, and don't reintroduce `cmd &; wait` for Claude — background async jobs
were implicated in TUI input garbling.

**The plugin bundle must stay mirrored.** `plugins/c-thru/` mirrors source
files from `tools/` and `skills/`. After editing a mirrored source file, run
`tools/sync-plugin-bundle.sh`. Confirm with
`tools/sync-plugin-bundle.sh --check` (also covered by `make test`).

**Worktree agents branch from `origin/main`, not local HEAD.** When you
dispatch parallel agents with `isolation: "worktree"` (via the Agent tool),
each worktree is created from `origin/main` HEAD — not from your local
unpushed commits. Any work in local commits that hasn't been pushed is
invisible to the agents. Always `git push` before dispatching worktree
agents. If a worktree agent produces stale output, check
`git log origin/main..HEAD` — anything listed there was not available to it.

Before starting any non-trivial task (or before opening a PR), run the
hygiene check — it's read-only and surfaces the hazards above before you
build on top of them:

```bash
bash tools/c-thru-hygiene-check.sh    # exit 0 clean / 1 warnings / 2 critical
```

It catches cross-user `/Users/<other>` paths in tracked files, broken
symlinks, secret-shaped strings (AKIA/ghp_/sk-/AIza), accumulated
experiment-artifact directories, large unstaged WIP, and local commits ahead
of `origin/main`. It is not gated — run it by hand.

---

## 10. Where to go next

You're set up, you can make a change, and the tests pass. From here, the
reading path is:

- [`README.md`](../README.md) — the reference doc. Routing modes, the agent
  routing reference table, the plugin-vs-CLI matrix, the full CLI flag
  reference. This is the map; come back here whenever you need a specific
  table.
- [`CLAUDE.md`](../CLAUDE.md) — the full developer reference. Env vars,
  runtime control, the model-map schema, the contributor invariants in
  depth. The authoritative source for "what does this field mean."
- [`docs/agent-architecture.md`](agent-architecture.md) — the wave lifecycle,
  STATUS contracts, the escalation chain, and the `agent_to_capability`
  traversal in detail. Read this when you start touching agents or the plan
  system.
- [`docs/review-methodology.md`](review-methodology.md) — how to run a
  deliberate whole-codebase review round (survey → adversarial verification
  → grouped fix dispatch → regression test → chronic-failure audit). Read
  this before your first review campaign, not during it.
- [`docs/test-authoring.md`](test-authoring.md) — the mechanical HOW of
  writing a test: suite conventions, the exit-code contract, registration in
  `run-all.sh`, fixture conventions. The companion to section 8 above.
- [`docs/anthropic-api-coverage.md`](anthropic-api-coverage.md) — the
  endpoint × backend coverage matrix (which Anthropic endpoints translate,
  passthrough, or 501 on each backend, plus content-block and server-tool
  sub-matrices). Read this before touching the proxy's translation paths.

For a first contribution, two shapes are friendly:

- **A routing-table cell change** — the section 6 walkthrough, generalized.
  Pick a capability × mode × tier cell in `config/model-map.json`, change
  one value, `make docs`, review the diff, run `make test`. Small, bounded,
  and it exercises the reload + derived-artifact path end to end.
- **A test coverage gap** — [`docs/test-coverage-audit.md`](test-coverage-audit.md)
  tracks what's currently untested, on a different axis from
  `test-authoring.md`. Pick a gap, write the test following the
  fail-then-pass discipline, register it in `run-all.sh`, and confirm
  `make test` stays green. This is the most reliable way to learn the
  codebase while producing something the project wants.

Both are real work, both leave the suite green, and both will teach you more
about the repo than the rest of this guide can. Pick one, and welcome.
