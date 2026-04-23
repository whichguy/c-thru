agent: implementer
target_resources: [core/crypto.c]
---
## Mission context
B1 Pattern Validation Spike: recusal

## Your task
Optimize the calculateEntropy function in core/crypto.c

Success criteria:
- [ ] Task completed
- [ ] Correct STATUS block returned


---

# Worker contract

This section is injected into every worker digest by `tools/c-thru-plan-harness.js inject-contract`.
Single source of truth for drift-prone boilerplate. See: docs/agent-architecture.md §12.1.

---

## Response structure

**Do NOT write files directly.** You must follow the exact structure provided in the `### REQUIRED RESPONSE TEMPLATE` at the very end of this document.

1.  **Copy the template** from the end of this file.
2.  **Fill in the placeholders** `[...]` with your actual work, data, and findings.
3.  **Return only the completed template** (and your preceding logic/reasoning) as your response.

Every task MUST include at least one `improvement` finding. What would make the next iteration of this work easier or higher quality?

---

## Self-recusal criteria

Apply BEFORE starting work.

**Recuse if ANY of:**
- Cannot identify the specific existing pattern to satisfy success criteria.
- Success criteria cannot be verified by available means.
- Two or more valid interpretations exist — choosing wrong one fails verification.
- You have attempted the work but cannot establish it is correct (set `ATTEMPTED: yes`).

When recusing, use the `STATUS: RECUSE` format from the template and omit `WROTE`, `INDEX`, `FINDINGS`, and `FINDING_CATS`.

---

## Post-work linting

After completing all code edits, run available linters against each modified file before returning STATUS. Cap: 5 fix-and-retry iterations.

- `.sh` / `.bash`: `bash -n <file>`; also `shellcheck <file>` if available
- `.js` / `.mjs` / `.cjs`: `node --check <file>`
- `.ts` / `.tsx`: `node --check <file>` (per-file tsc is unreliable without tsconfig)
- `.json`: `python3 -m json.tool <file> > /dev/null` if available (skip `.jsonc`)


### REQUIRED RESPONSE TEMPLATE

## Work completed
[Briefly describe what you did here. If you discovered new patterns or invariants, add a `### Learnings` subsection below.]

## Findings (jsonl)
```jsonl
{"class":"improvement","text":"[Required: what would make the next iteration easier?]","detail":"[optional prose]"}
[Add other trivial|contextual|plan-material|crisis findings here]
```

## Output INDEX
[List changed sections, e.g., src/main.js: 10-50]

STATUS: [COMPLETE|PARTIAL|ERROR|RECUSE]
CONFIDENCE: [high|medium|low]
UNCERTAINTY_REASONS: [List rubric bullets if medium/low; omit if high]
WROTE: [comma-separated paths from target_resources]
INDEX: [output.INDEX.md path or none]
FINDINGS: [findings.jsonl path or none]
FINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}
LINT_ITERATIONS: [number]
SUMMARY: [≤20 words summary]

**Note for RECUSE:** If you recuse, use `STATUS: RECUSE` and provide `RECUSAL_REASON: [reason]` and `ATTEMPTED: [yes|no]`. Omit WROTE, INDEX, and FINDINGS.


IMPORTANT: You MUST complete the template above. Replace all `[...]` placeholders with actual content. Do not leave the brackets in your final response.