---
name: review-plan Banner Alignment
type: entity
description: "Tier banner/scorecard width mismatch and emoji column-width bugs in review-plan SKILL.md output (LLM pseudocode, hand-typed literals, pad formula)"
tags: [review-plan, formatting, banner, scorecard, terminal, emoji-width]
confidence: high
last_verified: 2026-04-20
created: 2026-04-20
last_updated: 2026-04-20
sources: [session-961929c3]
related: [c-thru-statusline]
---

# review-plan Banner Alignment

Tier banners and scorecards in `skills/review-plan/SKILL.md` are hard-coded string literals that the LLM prints verbatim. Because there is no `pad(text, width)` helper (the model doesn't execute code at print time), every banner is hand-typed and prone to width drift on edit.

- **From Session 961929c3:** Discovered that all three tier banners (TRIVIAL, SMALL, FULL) were 48 chars wide while their corresponding scorecards were 56 chars wide. The 48→56 step on successive box frames created a "double-border" visual artifact reported by users. Root cause: each banner was independently eyeballed rather than derived from a shared width constant. Fix: normalize all banners to 56 chars with documented width formula: `pad = 50 − labelLen − tierLen`.

- **From Session 961929c3:** Emoji characters in banners (`⚡` U+26A1, `◆` U+25C6) and scorecards (`🟢` U+1F7E2) have different display widths in most terminals (wide emoji = 2 columns, narrow symbol = 1). This caused the right `║` border to misalign by 1 column on Rating lines. Fix: drop emoji prefixes from banners (structural headers); keep `🟢` in scorecards but compensate trailing spaces.

- **From Session 961929c3:** A plan was created and reviewed (`~/.claude/plans/luminous-cooking-bengio.md`, status READY) but implementation was interrupted before edits to SKILL.md were made. The plan also adds width-formula comments above each banner block to prevent future drift.

→ See also: [[c-thru-statusline]] (related terminal output formatting)