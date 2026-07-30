---
name: c-thru-advisors
description: >
  c-thru multi-model advisor panel: parallel fleet seat agents, optional second
  pass with peer context, host synthesis. Use when the user runs /c-thru-advisors,
  says "c-thru advisors", "fleet advisors panel", or wants independent c-thru-routed
  perspectives then a consolidated verdict. Seats come from config advisor_panels
  for the active connectivity mode. Requires a cthru CLI launch (fleet inject).
  Not the global Grok-native "advisors" skill (ask-opus/ask-codex).
---

# c-thru-advisors (fleet multi-agent panel)

Run a **two-pass deliberation** with seats from `config/model-map.json` →
`advisor_panels` for the **active connectivity mode**.

| Pass | Behavior |
|------|----------|
| **1** | Same prompt → each seat **in parallel** as `Agent(subagent_type: <seat>)` |
| **2** | Each seat again **in parallel** with own pass-1 + peer pass-1; may ADOPT / REVISE / REJECT |
| **Host** | **This** session synthesizes `final.md` (never invent failed seats) |

**Requires `cthru` CLI fleet inject.** Marketplace plugin alone does not ship this
skill or the seat agent fleet (Shape C lean plugin).

**Not** the Grok-native global skill named `advisors` (ask-opus / ask-codex /
headless grok). Prefer `/c-thru-advisors` so the two do not collide.

## Hard preflight (abort — do not degrade)

**Stop immediately** (do not invent multi-seat answers) if any of:

1. `c-thru` / `cthru` is not available on PATH for resolution, or  
2. `c-thru explain --panel <role> --format json` fails or returns `errors` / fewer than 2 seats, or  
3. This session is not a **c-thru launch** (no fleet `--agents` inject). Indicators that you are under c-thru: ephemeral session / statusline / routing context from c-thru; if the user is on plain `claude` or plugin-only without CLI fleet, **abort**.

Abort message (verbatim idea):

> c-thru-advisors requires a `cthru` launch (CLI agent fleet inject). Plugin-only or plain Claude cannot run the panel. Install/run: `bash install.sh` then `cthru`, then `/c-thru-advisors …`.

## When to use

- `/c-thru-advisors …` / “c-thru advisors …” / “fleet advisors panel”
- High-stakes design, risk, trade-off, or multi-perspective review

**Not for:** trivial one-liners, pure implementation, `/cplan` waves, or the
global Grok `/advisors` skill.

## Preflight — resolve the panel

1. Strip leading `/c-thru-advisors` noise.  
2. Optional `--panel <role>` (default `default`). Missing roles fall back to `default` **for the same mode** only.  
3. Resolve:

```bash
c-thru explain --panel <role> --format json
# optional: --mode <m> --tier <t>
```

Expect JSON `seats: [{ name, model, capability, pin }, …]` with empty `errors`.
Print seat → model table (note keys: e.g. Grok needs `XAI_API_KEY`).

## Run directory

```bash
RID=$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 2)
RUN="${TMPDIR:-/tmp}/c-thru/advisors/${RID}"
mkdir -p "$RUN"
# write user question to $RUN/prompt.txt
```

## Pass 1 — independent seats

For each seat in parallel:

```
Agent(
  subagent_type: "<seat.name>",
  description: "c-thru-advisors pass1 <seat.name>",
  prompt: <contents of prompt.txt>
)
```

Write `$RUN/pass1-<seat.name>.md`. Record failures in `$RUN/pass1-meta.json`.

| Survivors | Action |
|-----------|--------|
| **0** | Stop; report meta; no fake consensus |
| **1** | Continue; label **single-source / low confidence** |
| **≥2** | Normal |

## Pass 2 — peer-aware self-augment

Re-dispatch survivors with own + peer pass-1; seat replies `NO ADDITIONAL ITEMS` or ADOPT/REVISE/REJECT only. Write `$RUN/pass2-<seat.name>.md`.

## Host synthesis

Write `$RUN/final.md`: scoreboard, agreements, D# disagreements, dispositions, combined answer, convergence, confidence. Never invent failed seats; seat count is not evidence.

## Config

```bash
c-thru explain --panel default --mode best-cloud-oss --tier 64gb
c-thru explain --panel default --mode best-cloud-gov --format json
```

Change seats via `advisor_panels` (or user overrides), not by editing brand agent files from this skill.
