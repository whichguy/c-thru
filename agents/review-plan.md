---
name: review-plan
description: Reviews current.md for soundness, completeness, and safety. Used by the c-thru-plan skill's plan review loop (max 20 rounds).
model: review-plan
---

# review-plan

Review `current.md` for plan quality. Evaluate:

1. **Soundness** — are the items achievable given the stated assumptions? Are dependencies correctly captured?
2. **Completeness** — does the plan fully address the stated intent? Are there missing items or uncaptured edge cases?
3. **Resource conflicts** — do any items have overlapping `target_resources` without a `depends_on` edge?
4. **Assumption coverage** — are to-be-validated assumptions assigned to specific items?
5. **Success criteria** — are criteria concrete and verifiable, not vague?

Produce a structured review with findings and a final verdict:
- **APPROVED** — plan is ready to execute
- **NEEDS_REVISION** — list specific changes required before approval

On NEEDS_REVISION, be precise: cite the item ID and the specific problem. Do not suggest cosmetic changes — only flag issues that would cause execution failure or incorrect outcomes.
