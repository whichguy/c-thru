.PHONY: test test-fast test-live check lint docs

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
