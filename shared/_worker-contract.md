# Worker contract

This section is injected into every worker digest by `tools/c-thru-plan-harness.js inject-contract`.
Single source of truth for drift-prone boilerplate. See: docs/agent-architecture.md §12.1.

---

## Response structure

**Do NOT write files directly.** The orchestrator parses your response into three artifacts:

1. `## Work completed` section (with `### Learnings` subsection) → wave outputs directory
   ```markdown
   ## Work completed
   <what was done — file/change/integration point>

   ### Learnings
   <patterns, invariants, or constraints discovered>
   ```

2. `## Findings (jsonl)` fenced code block → parsed line-by-line into wave findings directory
   ```markdown
   ## Findings (jsonl)
   ```jsonl
   {"class":"trivial|contextual|plan-material|crisis|augmentation|improvement","text":"<≤80 char summary>","detail":"<optional longer prose>"}
   ```
   ```
   `detail` is optional — omit when `text` is self-contained.

   **Improvement required:** emit at least one `improvement` entry per task. What would make next wave's version of this work easier or higher-quality? If nothing, write `{"class":"improvement","text":"none — task was clean"}`.

3. `## Output INDEX` section → wave outputs directory
   ```markdown
   ## Output INDEX
   <section>: <start>-<end>
   ```

---

## Self-recusal criteria

Apply BEFORE starting work. The fourth signal fires mid-execution.

**Recuse if ANY of:**
- Cannot identify the specific existing pattern to satisfy success criteria
- Success criteria cannot be verified by available means
- Two or more valid interpretations exist — choosing wrong one fails verification
- Attempted this; produced output but cannot establish it is correct (set ATTEMPTED: yes)

When recusing: do NOT include WROTE, INDEX, FINDINGS, or FINDING_CATS in the STATUS block.

---

## Post-work linting

After completing all code edits, run available linters against each modified file before returning STATUS. Cap: 5 fix-and-retry iterations.

- `.sh` / `.bash`: `bash -n <file>`; also `shellcheck <file>` if available
- `.js` / `.mjs` / `.cjs`: `node --check <file>`
- `.ts` / `.tsx`: `node --check <file>` (per-file tsc is unreliable without tsconfig — use node --check as fallback)
