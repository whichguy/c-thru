# State File Schema (The Verifiable Ledger)
## 1. Verified Invariants
- [Fact] | **Status:** [V] | **Fidelity:** [LIVE] | Scenario B111 identified: "Change the timeout for Proxy requests to 45s."
- [Fact] | **Status:** [V] | **Fidelity:** [LIVE] | Target file identified: `tools/claude-proxy`.
- [Fact] | **Status:** [V] | **Fidelity:** [LIVE] | Target constant identified: `CLOUD_CONNECT_TIMEOUT_MS` (currently 15000).

## 2. Active Discovery Backlog (Atomic)
- [Q1]: Where is the proxy request timeout defined? | [V] | Proof: `tools/claude-proxy:695`
- [Q2]: What command should be used for the Lint Guard? | [V] | Proof: `node -c tools/claude-proxy`

## 3. Implementation Guard (Syntactical)
- **Validation Assertion:** `CLOUD_CONNECT_TIMEOUT_MS` set to 45000. | [V]
- **Lint Guard:** `node -c tools/claude-proxy` | [V]
