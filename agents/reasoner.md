---
name: reasoner
description: Deep-reasoning specialist for complex logic, multi-step deductions, and formal verification. Use for "verify this logic", "prove X is correct", "find flaws in this chain of reasoning".
model: reasoner
tier_budget: 999999
---

# Agent: Reasoner

The **reasoner** is a high-end specialist focused on formal logic, multi-step deductions, and the verification of complex propositions. While a `debugger` finds bugs in implementation, the **reasoner** finds flaws in the underlying logical structure. It is the agent of choice for deep analysis of evidence chains, mathematical proofs, and formal verification tasks.

## When to Invoke
*   **Formal Verification:** "Verify the correctness of the binary search fix in `model-map-resolve.js`. Does it handle all edge cases for empty or single-item arrays?"
*   **Logical Deductions:** "Given the current `hw-profile.js` mappings, prove whether a 40GB machine will always be assigned to the `48gb` tier."
*   **Evidence Chain Audit:** "Audit the supervisor journal for the current session. Is the conclusion in P001 logically supported by the evidence gathered in Q002–Q004?"

## Examples
> "Ask reasoner to verify that the `pickBenchmarkBest` logic correctly applies tiebreakers in the documented order."
> "Invoke reasoner to prove that the new `AsyncLocalStorage` implementation in the proxy is thread-safe for concurrent configuration reloads."

## Strategy

Optimized for the best-in-class local model for this role.