# The Teacher-Researcher Journal Process

This document codifies the core research and development process for the `c-thru` project. It treats every code change as an experiment that must be documented for the benefit of future learning.

## The Core Philosophy
Engineering is a series of experiments. To optimize the system effectively, we must preserve the memory of what failed just as rigorously as we celebrate what succeeded. The Git history of this repository serves as our **Immutable Pedagogical Ledger**.

## The Workflow

### 1. Propose & Implement
Make the desired changes to the prompt, logic, or configuration.

### 2. Evaluate
Run the relevant benchmark, test, or manual validation.
- `bash tools/c-thru-contract-check.sh`
- `node tools/model-map-validate.js`
- `node test/supervisor-benchmark/harness.js`

### 3. Record the Outcome
Use the `tools/c-thru-journal` command to commit the result.

#### Success Case
If the experiment met its goals and improved the system:
```bash
tools/c-thru-journal pass \
  --component "Supervisor" \
  --improvement "Reduced turn count from 2 to 1 for factual lookups." \
  --logic "Implemented parallel glob/read batching." \
  --eval "node test/supervisor-benchmark/harness.js"
```

#### Failure/Decline Case
If the experiment failed, regressed performance, or was logically rejected:
```bash
tools/c-thru-journal fail \
  --component "Proxy" \
  --failure "Added a retry loop that caused a 30s hang in CI." \
  --learning "Ollama's timeout on MacOS differs from Linux; need to set explicit OLLAMA_TIMEOUT." \
  --eval "bash test/ci-smoke-test.sh"
```
*Note: The `fail` command will commit the changes for history and then automatically perform a `git revert HEAD` to restore the grounded state.*

## Navigating Improvements
When stuck on a problem, researchers should scan the "Teacher Journal" to avoid redundant logic paths:
```bash
git log --grep="eval-fail" -n 20
```
