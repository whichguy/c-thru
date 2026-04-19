# Review-Plan Question Definitions — Layer 3 (UI Evaluator)

This file is read by the ui-evaluator only. It contains L3 UI questions (Q-U1 through Q-U7)
plus two L2 Client cluster questions (Q-C17, Q-C25) merged into the ui-evaluator when HAS_UI=true.

For the full question set (L1 + L2 + L3), see QUESTIONS.md.

## Gate Weight Reference
Gate 1 (blocking, weight 3) | Gate 2 (important, weight 2) | Gate 3 (advisory, weight 1)
N/A counts as PASS for gate evaluation.

---

## Layer 3: UI Specialization

*11 questions total: Q-U1 through Q-U9 + Q-C17 + Q-C25. Active when HAS_UI=true.*

*For each question: evaluate → **PASS** / **NEEDS_UPDATE** / **N/A***

| Q | Question | Criteria | N/A |
|---|----------|----------|-----|
| Q-U1 | Component structure | Reusable UI components? Flag: monolithic HTML, duplicated patterns, no layout/state/interaction split. | no new UI components |
| Q-U2 | State management | UI states (loading/error/empty/data) explicit? Spinner/skeleton, error display, empty-state copy? | purely presentational changes with no dynamic state |
| Q-U3 | Interaction feedback | User actions give immediate feedback? Disable-during-submit, progress indicator, success/error toast. | no interactive elements |
| Q-U4 | Responsive & layout constraints | Container-aware? GAS sidebar=300px, dialog≤600px. No overflow or fixed widths breaking sidebar. | no layout/sizing changes |
| Q-U5 | Accessibility basics | Accessible labels (aria-label, for/id on inputs)? Logical tab order, keyboard nav intact. | no new interactive elements |
| Q-U6 | Visual consistency | Matches design system (fonts, colors, spacing, buttons)? No one-off inline styles diverging from patterns. | no visual changes or the project has no existing baseline |
| Q-U7 | UI design narrative | Design narrative present? Section titled UI Design Narrative/User Experience/Design Intent, 2-5 sentences on flow+states+rationale. Flag: impl sans narrative. EDIT: `## UI Design Narrative\n**User experience**: [flow]\n**Design intent**: [rationale]\n**State transitions**: [loading/error/empty/success]`. | purely presentational changes with no interaction or new components; plan explicitly references an existing design spec |
| Q-U8 | Iterative UI verification | Plan includes visual verification step using chrome-devtools, screenshots, or similar tooling to validate the UX after implementation? Flag: UI changes with no verification beyond "it renders." EDIT: `[EDIT: add verification step: "Take screenshot with chrome-devtools / open sidebar and verify [specific UX behavior]"]`. | no visual UI changes; backend-only; plan uses an existing E2E test suite that covers the UI |
| Q-U9 | CSS/HTML organization | CSS/HTML follows cohesive organization? Flag: inline styles over classes, no separation of layout/theme/component styles, no naming convention, scattered style definitions, HTML mixing structure and presentation. | no CSS/HTML changes; purely JS/logic changes; project has no existing CSS baseline to align with |

---

### Client Cluster Questions (merged into ui-evaluator when HAS_UI=true)

The following 2 questions are evaluated by the ui-evaluator when HAS_UI=true
(merged from Client cluster — no separate client-evaluator is spawned).

| Q | Gate | Question | Criteria | N/A |
|---|------|----------|----------|-----|
| Q-C17 | 2 | Event listener cleanup | Listeners removed to prevent accumulation/leaks? | no new listeners |
| Q-C25 | 3 | UI error boundary | Client error boundary for silent failures? window.onerror, try/catch on init. | no new client logic |

IS_GAS: **fully superseded when HAS_UI=true** (gas-evaluator Q32, Q33).
IS_NODE: not superseded — evaluate normally.

Count ui-evaluator edits → `ui_plan_changes += count` (combined into `changes_this_pass` in Convergence Loop)
