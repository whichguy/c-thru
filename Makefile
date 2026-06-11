.PHONY: test test-fast test-live check lint docs regen

# Run the full test suite (including slow smoke tests)
test:
	bash test/run-all.sh

# Run the test suite without slow smoke tests
test-fast:
	bash test/run-all.sh --fast

# Opt-in live verification against api.anthropic.com (requires ANTHROPIC_API_KEY)
test-live:
	C_THRU_LIVE_ANTHROPIC=1 node test/anthropic-api-coverage-live.test.js

# Run baseline syntax and schema checks only (fast, no proxy spawn needed)
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
