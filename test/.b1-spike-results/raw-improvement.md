## Work completed
I have extracted the `sum` function from `math.js` into a new file `sum.js`. I updated `math.js` to import the `sum` function from `sum.js` to maintain existing functionality and exports.

1.  **Created `sum.js`**: Contains the `sum` function implementation.
2.  **Updated `math.js`**: Removed the inline definition of `sum` and added an import statement from `./sum.js`. Re-exported `sum` to maintain the module's public API.

### Learnings
- The `sum` function was a simple utility, making it a good candidate for extraction.
- Ensuring re-exports in `math.js` is crucial if other modules depend on `math.js` for the `sum` function.

## Findings (jsonl)
```jsonl
{"class":"improvement","text":"Add unit tests for the extracted sum.js module to ensure isolation and correctness.","detail":"Currently, there are no specific tests mentioned for sum.js. Adding tests will prevent regressions during future refactoring."}
```

## Output INDEX
sum.js: 1-5
math.js: 1-10

STATUS: COMPLETE
CONFIDENCE: high
UNCERTAINTY_REASONS: []
WROTE: sum.js, math.js
INDEX: none
FINDINGS: none
FINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}
LINT_ITERATIONS: 0
SUMMARY: Extracted sum function from math.js to sum.js and updated imports.


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