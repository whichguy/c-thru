---
name: Review-Fix Intent Alignment
type: entity
description: "Failure mode where review-fix treats intentional new additions as quality issues and reverts them — can't distinguish planned code from defects without plan context"
tags: [agents, review-fix, failure-mode, intent-alignment, quality-gate]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [3dfdb834]
related: [agent-prompt-construction, implementer-lint-loop]
---

# Review-Fix Intent Alignment

Known failure mode of the review-fix agent: when reviewing newly added code sections (particularly agent prompt directives and STATUS contract extensions), review-fix can't distinguish intentional additions from quality defects. It treats new prose sections and new STATUS fields as removable findings, reverting planned changes and potentially deleting the feature branch.

- **From Session 3dfdb834:** During POST_IMPLEMENT review-fix on the implementer lint-loop feature, the review-fix agent reverted the `## Post-work verification` section from both `agents/implementer.md` and `agents/implementer-cloud.md`, removed `LINT_ITERATIONS: N` from the STATUS block, and deleted the feature branch instead of merging. Required manual re-application of all 4 file changes. The `plan_summary` parameter (designed to check intent alignment) was present but insufficient — the reviewer still treated new additions as findings to fix by removal.
- **From Session 3dfdb834:** Mitigation strategies: (1) pass `plan_summary` to review-fix so reviewers can check findings against the plan's stated approach (already implemented but insufficient alone), (2) for agent prompt files, reviewers should treat new sections and STATUS fields as intentional unless they contradict a stated invariant, (3) consider a `--no-revert` mode that only suggests fixes without removing code, (4) post-review-fix: always verify that planned additions are still present before pushing.

→ See also: [[agent-prompt-construction]], [[implementer-lint-loop]]