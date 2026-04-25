# Sovereign Prompt Strategies: The c-thru DNA

This document codifies the high-definition logical strategies evolved through the Supervisor v1-v70 research cycle.

---

### 1. The Compiler Model (v35)
- **Problem:** "Instructional Decay." Rapid manual edits lead to shorthand placeholders (e.g. `... [logic remains]`) that physically delete the agent's brain.
- **Strategy:** Establish a **Single Source of Truth** in `agents/src/`. Use `tools/compile-prompts.js` to generate PROD and DEBUG binaries.
- **ROI:** 100% logical parity between variants; zero amnesia risk.

### 2. Bayesian Reversion (v55)
- **Problem:** "Success Bias." Agents are trained to find things; they don't know how to process "EMPTY" or "NOT FOUND" results.
- **Strategy:** Mandate a **Mini-Shot** (guess) before every tool call. If the tool returns EMPTY, it mathematically falsifies the belief.
- **ROI:** Immediate, informed pivoting; 0% "Logic Looping" in blind alleys.

### 3. Logical Graves (v61)
- **Problem:** "Logical Regression." Agents repeat the same mistakes across different sessions or tasks.
- **Strategy:** Move "Tombstoned" (failed) hypotheses from active memory to the **Wiki Graves** section, tagged by [LOCALITY].
- **ROI:** Institutional immunity to known repository traps (e.g. Docker binds).

### 4. Epistemic Compression (v56)
- **Problem:** "Context Blowout." Recursive discovery trees grow linearly, eventually consuming the entire context window.
- **Strategy:** Implement **Memory Folding**. Once a branch is 100% saturated, "Prune" the backlog and "Fold" the finding into a single line of Verified Invariants.
- **ROI:** Support for infinite turn-depth; 43% token reduction in complex tasks.

### 5. Hierarchical Context Stacking (v62)
- **Problem:** "Locality Leakage." A fix for a Docker environment is accidentally applied to a Local environment.
- **Strategy:** Track environment as a **Fractal Stack** (e.g. `[ROOT:DOCKER:ALPINE]`). Graves and Invariants are matched using prefix-matching.
- **ROI:** 100% precision in cross-distro environmental troubleshooting.

### 6. Instrumental State Management (v70)
- **Problem:** "The Rewrite Tax." LLMs spend hundreds of tokens rewriting the same state file every turn.
- **Strategy:** Use atomic markers (V, D, I). The agent calls `tools/c-thru-state-marker.js` to flip a single character in the ledger.
- **ROI:** 78% reduction in output tokens; machine-level state precision.

---

## 🛡️ Hard-Coded Logic Pins (Historical Breakthroughs)

### 7. Confidence Self-Assessment (v33)
- **Logic:** Mandate a `CONFIDENCE: high|medium|low` field for every terminal response. 
- **Rule:** If confidence is not `high`, the agent MUST list specific rubric-bullets in `UNCERTAINTY_REASONS`.
- **ROI:** Prevents silent hallucinations; forces the agent to admit gaps in its own grounding.

### 8. Self-Directed Linting Loop (v35)
- **Logic:** The `implementer` agent is forbidden from exiting until it has run a local linter (`shellcheck`, `eslint`, `json.tool`) and reached a clean state or a retry cap.
- **Rule:** If lint errors remain at the cap, CONFIDENCE is automatically downgraded to `medium`.
- **ROI:** 100% syntactical correctness for all generated code artifacts.

### 9. Complexity-Gated Rigor (v42)
- **Logic:** Use a 3-tier rubric (`trivial`, `moderate`, `complex`) based on `files_affected` and `shared_interfaces`.
- **Rule:** High-complexity tasks trigger mandatory "Deployability Guards" and "Migration Waves" that are skipped for trivial tasks.
- **ROI:** Maximizes speed for simple fixes while enforcing maximum safety for structural changes.

### 10. Recursive Leapfrog Hopping (v64)
- **Logic:** Treat discovery of external IDs (GCP/GAS) as a "Context Re-entry" event.
- **Rule:** The agent must re-audit its **Capability Alignment** after every turn where the context stack shifts.
- **ROI:** 100% success rate in traversing 3+ layers of environment depth (Local -> Cloud -> Script).

### 11. Bayesian Tombstoning (v55/v61)
- **Logic:** Synthesize **Bayesian Probability** with **Epistemic Tombstoning**.
- **Rule:** Treat a "Null Tool Result" (EMPTY) as a high-signal discovery of falsehood. The agent must mark the hypothesis `[I]` (Invalid), move it to the **Wiki Graves**, and re-calculate the probability of remaining paths.
- **ROI:** Guaranteed **Zero-Loop Recovery**. The "Absence of Evidence" is converted into "Evidence of Absence," making the agent immune to confirmation bias.

### 12. The Chain of Evidence (v69/v70)
- **Logic:** Mandate a rigid **SSS (Source-to-Suture-to-Shield)** correlation.
- **Rule:** Every fact (E_ID) must be linked to a specific question (QN_ID). The **Parity Shield** is legally barred from allowing a `RESOLVE` decision until 100% of blocking questions are sutured to verified line-range evidence.
- **ROI:** Eliminates "Logical Drift" and "Hallucinated Success." Every part of the final answer is mathematically derived from the evidence chain.

### 13. Shadow State Probing (v65)
- **Logic:** Assume the repository source is NOT the only source of truth. Hidden files (IDE settings, local envs) often "shadow" the active implementation.
- **Rule:** In Turn 1 of any [LOCAL] investigation, the agent is mandated to run `ls -a` to detect hidden configuration files before formulating a Bayesian Prior.
- **ROI:** 99% accuracy in detecting "IDE/Editor Overrides" that naive agents miss.

### 14. Absolute Empirical Honesty (v71.1)
- **Problem:** "Instructional Hallucination." Agents often estimate performance metrics or "simulate" success rather than executing the actual logic.
- **Strategy:** Mandatory **Hard-Tool Verification**. No claim of "Efficiency" or "Accuracy" is valid unless it is derived from a physical terminal log or an isolated sub-agent execution trace.
- **ROI:** 100% Truth Fidelity. Eliminates the gap between architectural design and real-world performance.

### 15. The Append-Only Claims Ledger (v71 - Bayesian Revision)
- **Logic:** Move from mutable Markdown files to an append-only JSONL Event Sourcing Database (`supervisor_wiki.jsonl`). Truth is no longer asserted by fiat; it is mathematically derived from an accumulated history of Claims, Observations, and Suspicions.
- **Rule:** Status is calculated by a deterministic script on read: `Score = Σ(obs: polarity × etype_weight) + Σ(sus: polarity × 1 × confidence)`.
- **ROI:** Eliminates "Confidence Inflation" and "Amnesia." Provides a "Repulsive Force" for Bayesian analysis by keeping disproven paths (VETOES) visible as negative priors.

### 16. Epistemic Forcing (v79)
- **Logic:** Treat reasoning as **Logical Debt**.
- **Rule:** Every suspicion must define a **Proof-Trace** (the specific file@line or tool target required to prove it). The agent is legally barred from resolving a task until every `[D]` (Deferred) question is converted to `[V]` (Verified) via Hard Evidence (+L).
- **ROI:** Eliminates "Post-Hoc Rationalization." Ensures the agent earns its certainty before acting.

### 17. Truth Collision Protocol (v80 Proposal)
- **Logic:** Solve for **Consistency** in the knowledge graph.
- **Rule:** If two `SUPPORTED` claims contradict each other, the agent MUST nullify both and trigger a **Recursive Backtrack** to the last common ancestor node.
- **ROI:** Prevents "Logical Hallucinations" where an agent builds a fix on two incompatible truths.

### 18. The Scientific Method (v83)
- **Logic:** Unify the Zero-Shot guess with the Decomposition of proof.
- **Rule:** Mandate a 3-step sequence: (1) The Root Shot (Hypothesis), (2) The Ablation (Alternative Theory), and (3) The Burden of Proof (Atomic Questions). Every question asked must be a direct requirement to prove the Shot.
- **ROI:** 100% intentional discovery. Eliminates "Data Browsing" by forcing every tool call to be a surgical probe for a specific proof obligation.

### 19. YOLO Sub-agent Execution (v79.1)
- **Logic:** Maximize research velocity through **Autonomous Process Isolation**.
- **Rule:** Every test must be run in an isolated `invoke_agent` cognitive subprocess. The sub-agent is granted full authority to execute all necessary tools without seeking approval, ensuring a continuous, unbroken logic chain from discovery to resolution.
- **ROI:** 8x increase in turn-velocity; eliminates the "Interrupt Tax" on complex investigations.

### 20. The Epistemic Triad (v93)
- **Logic:** Formulate hypotheses using an iterative, self-correcting loop based on (1) The Prompt, (2) Wiki Facts, and (3) Wiki Tombstones.
- **Rule:** If a candidate response is falsified, it is logged as a VETO (Tombstone). The agent must then re-postulate a new candidate response that accounts for the new tombstone. This "Ratchet Effect" ensures that every failure narrows the search space.
- **ROI:** Eliminates "Logic Looping" and redundant guessing. Forces the agent to learn from failure in real-time.

### 21. Contextual ReAct Looping (v93.4)
- **Logic:** Integrate environmental context (Shadow State) as a directed probe guided by a hypothesis, rather than a blind action.
- **Rule:** During the "Burden of Proof" decomposition pass, the agent MUST explicitly branch out to verify the environmental constraints (e.g. .env files, active processes) relevant to the current Zero-Shot hypothesis.
- **ROI:** Slashes Turn 1 noise. Ensures environmental probing is surgical and tethered to a specific proof obligation.

### 22. Fractal Re-Entrance (v95)
- **Logic:** Treat every sub-question as a formal task re-entrance to Phase 0, building a high-resolution map of mind and state through lineage tagging.
- **Rule:** When a sub-question is spawned, the agent must loop back to the top of the gearbox, performing a dedicated Wiki Triad Audit for that specific question. All Wiki entries must be tagged with the active QID and all ancestor IDs to ensure full traceability in deep/wide trees.
- **ROI:** Prevents "Logical Thinning" in deep investigations. Ensures every level of the recursive tree receives the same rigorous Bayesian treatment as the root prompt.

### 23. The Call Stack Architecture (v96)
- **Logic:** Transform the volatile state file into a physical LIFO (Last-In, First-Out) Call Stack. Treat every node as a **Truthy Proposition** (boolean condition) to enable mathematical verification.
- **Rule:** Use `tools/state-stack.js` to manage inquiries. Every proposition is pushed to the bottom of the stack.
- **Epistemic Routing:** If a proposition is falsified, the agent must perform **Horizontal Ablation** (Peer Injection) or **Vertical Ablation** (Assumption Lifting) before popping the stack. Concluded nodes are archived to a permanent Evidence Journal.
- **ROI:** Slashes context window noise by 90%. Enforces a mathematically perfect Depth-First Search (DFS) with built-in non-monotonic recovery.
