.PHONY: test test-all test-fast test-live test-live-all check lint docs regen

# Default hermetic suite (CI / pre-push / everyday): skips slow smoke & long e2e.
# Concurrent-safe (proxy unit tests use random free ports).
# Prefer this over the deprecated alias `test-fast`.
test:
	bash test/run-all.sh --skip-smoke

# Full suite including smoke-check and long e2e (exclusive Ollama/port lock).
test-all:
	bash test/run-all.sh

# Deprecated alias — same as `make test`. Kept so old muscle memory / scripts
# keep working; new docs and CI should use `make test`.
test-fast: test

# Opt-in live verification against api.anthropic.com (requires ANTHROPIC_API_KEY)
test-live:
	C_THRU_LIVE_ANTHROPIC=1 node test/anthropic-api-coverage-live.test.js

# Single entrypoint for ALL live / opt-in suites — the same command the scheduled
# CI workflow (.github/workflows/live-suites.yml) runs and a human runs locally.
# Exports every live/opt-in gate read by test/run-all.sh, then runs the FULL suite
# so the live blocks register. Each gated suite self-skips when its
# API key / creds are absent, so this stays green-but-skipping until secrets are
# present. Gate names are kept in sync with the `if [[ "${...:-0}" == "1" ]]`
# branches in test/run-all.sh.
test-live-all:
	C_THRU_LIVE_ANTHROPIC=1 \
	C_THRU_LIVE_GEMINI=1 \
	C_THRU_LIVE_PARITY=1 \
	C_THRU_BEHAVIORAL_TESTS=1 \
	C_THRU_LIVE_AGENT_TESTS=1 \
	C_THRU_HIERARCHY_TESTS=1 \
	C_THRU_E2E=1 \
	C_THRU_OFFLOAD=1 \
	C_THRU_OFFLOAD_GATE=1 \
	C_THRU_LIVE_SELECTION=1 \
	bash test/run-all.sh

# Run baseline syntax and schema checks only (no proxy spawn needed)
check:
	bash -n tools/c-thru
	node --check tools/claude-proxy
	node --check tools/model-map-*.js tools/llm-capabilities-mcp.js
	node tools/model-map-validate.js config/model-map.json
	bash tools/c-thru-contract-check.sh

lint:
	@if [ -d node_modules ]; then npx eslint tools test; else echo "lint: run 'npm install' first to install eslint"; exit 0; fi

# Regenerate derived docs (the README "Agent routing reference" table) from config/model-map.json.
# The pre-commit hook runs `gen-routing-doc.js --check`, so run this after any config bump.
docs:
	node tools/gen-routing-doc.js

# Tier-2 regen (docs/derived-artifacts.md): rebuild ALL derived artifacts after a config bump,
# then show the diff — the human intent-gate stays: review the diff, confirm it is the
# *intended* change (e.g. only a model-id bump, no null/route-drop transitions), then commit.
# Honest scope: 2 of 3 derived artifacts regenerate (lineage snapshot, README table);
# test/resolve-capability.test.js has hand-authored pins with no generator, so the last
# step self-reports stale ids instead of rewriting them.
regen:
	node test/model-map-lineage.test.js --update
	node tools/gen-routing-doc.js
	node tools/check-pinned-model-ids.js
	@echo ""
	@echo "regen diff (review before committing):"
	@git diff --stat -- test/model-map-lineage.test.js README.md || true
