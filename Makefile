.PHONY: test test-all test-fast test-live test-live-shard test-live-artifacts test-live-all test-live-oss-brand check lint docs regen

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

# Scheduled CI entrypoint. SHARD is required so provider integrity and agent
# behavior are independently attributable and retryable. run-all.sh suppresses
# the deterministic registry when a live shard is selected; `make test` owns
# that coverage. Both shards are strict, and no child or aggregate may consume
# more than the 55-minute execution budget inside the 70-minute CI lifecycle.
test-live-shard:
	@case "$(SHARD)" in \
	  provider) \
	    C_THRU_TEST_TIMEOUT_SECONDS=3300 \
	    C_THRU_LIVE_SHARD=provider \
	    C_THRU_STRICT_LIVE_PROVIDERS=1 \
	    C_THRU_LIVE_ANTHROPIC=1 \
	    C_THRU_LIVE_GEMINI=1 \
	    C_THRU_LIVE_OPENAI=1 \
	    C_THRU_LIVE_XAI=1 \
	    C_THRU_LIVE_PARITY=1 \
	    bash test/run-all.sh ;; \
	  agent) \
	    C_THRU_TEST_TIMEOUT_SECONDS=3300 \
	    C_THRU_LIVE_SHARD=agent \
	    C_THRU_STRICT_LIVE_PROVIDERS=1 \
	    C_THRU_BEHAVIORAL_TESTS=1 \
	    C_THRU_LIVE_AGENT_TESTS=1 \
	    C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1 \
	    C_THRU_OFFLOAD=1 \
	    C_THRU_LIVE_SELECTION=1 \
	    bash test/run-all.sh ;; \
	  *) \
	    echo "test-live-shard: SHARD must be provider or agent" >&2; \
	    exit 2 ;; \
	esac

# Manual/pilot lane for the six artifact-bearing selection cases. It is
# intentionally separate from scheduled CI until repeated comparable campaigns
# establish cost and variance. The explicit route pin keeps image/PDF/oversized
# inputs on the intended connected multimodal capability instead of a
# host-memory-dependent 16gb fallback.
test-live-artifacts:
	C_THRU_TEST_TIMEOUT_SECONDS=3300 \
	C_THRU_LIVE_SHARD=agent \
	C_THRU_STRICT_LIVE_PROVIDERS=1 \
	C_THRU_OFFLOAD=1 \
	C_THRU_OFFLOAD_ARTIFACTS=1 \
	CLAUDE_LLM_MODE=best-cloud \
	CLAUDE_LLM_PROFILE=32gb \
	bash test/run-all.sh

# OSS brand-leaf identity + proxy lifecycle (local/manual). Direct hits backends
# via proxy; print runs independent c-thru -p per agent (KEEP_PROXY=0).
# Requires reachable Ollama/cloud pins; print also needs Claude Code auth.
test-live-oss-brand:
	C_THRU_TEST_TIMEOUT_SECONDS=3300 \
	C_THRU_LIVE_SHARD=agent \
	C_THRU_STRICT_LIVE_PROVIDERS=1 \
	C_THRU_LIVE_OSS_BRAND=1 \
	CLAUDE_LLM_MODE=best-cloud-oss \
	bash test/run-all.sh

# Compatibility entrypoint for a human who wants one local aggregate. Scheduled
# CI uses `test-live-shard` instead so it does not duplicate the deterministic
# suite or blur provider failures together with stochastic agent failures.
# The compatibility aggregate remains strict and shares the 3,300-second cap.
test-live-all:
	C_THRU_TEST_TIMEOUT_SECONDS=3300 \
	C_THRU_STRICT_LIVE_PROVIDERS=1 \
	C_THRU_LIVE_ANTHROPIC=1 \
	C_THRU_LIVE_GEMINI=1 \
	C_THRU_LIVE_OPENAI=1 \
	C_THRU_LIVE_XAI=1 \
	C_THRU_LIVE_PARITY=1 \
	C_THRU_BEHAVIORAL_TESTS=1 \
	C_THRU_LIVE_AGENT_TESTS=1 \
	C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1 \
	C_THRU_HIERARCHY_TESTS=1 \
	C_THRU_E2E=1 \
	C_THRU_OFFLOAD=1 \
	C_THRU_COORDINATOR=1 \
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

# Regenerate derived docs: the README "Agent routing reference" table (from config/model-map.json)
# and the README request-flow step-through (from docs/request-flow.html).
# Drift is checked by suite Validators (`node tools/gen-routing-doc.js --check` in make test);
# run this after any config bump that should rewrite the table.
docs:
	node tools/gen-routing-doc.js
	node tools/gen-request-flow-doc.js

# Re-render the two architecture diagrams from README.md into docs/request-flow.html.
# NOT part of `make test`: this shells out to mermaid-cli (external dep, headless
# Chromium) while test/run-all.sh is hermetic. The OUTPUT is guarded hermetically by
# test/docs-html-integrity.test.js. Run after editing either diagram in README.md.
# Needs network on a cold npx cache; the pinned CLI version lives in the tool.
diagrams:
	node tools/gen-request-flow-svgs.js

# Tier-2 regen (docs/derived-artifacts.md): rebuild ALL derived artifacts after a config bump,
# then show the diff — the human intent-gate stays: review the diff, confirm it is the
# *intended* change (e.g. only a model-id bump, no null/route-drop transitions), then commit.
# Honest scope: 3 of 4 derived artifacts regenerate (lineage snapshot, README routing table,
# README request-flow step-through); test/resolve-capability.test.js has hand-authored pins
# with no generator, so the last step self-reports stale ids instead of rewriting them.
regen:
	node test/model-map-lineage.test.js --update
	node tools/gen-routing-doc.js
	node tools/gen-request-flow-doc.js
	node tools/check-pinned-model-ids.js
	@echo ""
	@echo "regen diff (review before committing):"
	@git diff --stat -- test/model-map-lineage.test.js README.md || true
