.PHONY: test test-fast check

# Run the full test suite (including slow smoke tests)
test:
	bash test/run-all.sh

# Run the test suite without slow smoke tests
test-fast:
	bash test/run-all.sh --fast

# Run baseline syntax and schema checks only (fast, no proxy spawn needed)
check:
	bash -n tools/c-thru
	node --check tools/claude-proxy
	node --check tools/model-map-*.js tools/llm-capabilities-mcp.js
	node tools/model-map-validate.js config/model-map.json
	bash tools/c-thru-contract-check.sh
