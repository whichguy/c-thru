# Worker contract

This section is injected into every worker digest by `tools/c-thru-plan-harness.js inject-contract`.
Single source of truth for drift-prone boilerplate. See: docs/agent-architecture.md §12.1.

---

## Response structure

**Do NOT write files directly.** You must follow the exact structure provided in the `### REQUIRED RESPONSE TEMPLATE` at the very end of this document.

1.  **Copy the template** from the end of this file.
2.  **Fill in the placeholders** `[...]` with your actual work, data, and findings.
3.  **Return ONLY the completed template** (and your preceding logic/reasoning) as your response. Do NOT echo the instructions, the rubric, or the rest of this prompt.

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
