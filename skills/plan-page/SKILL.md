---
name: plan-page
description: |
  Enrich and open the live c-thru plan dashboard without spending tokens on
  duplicating its deterministic plan state. Subcommands: [free text] | --plan
  <wave-slug|snapshot-id> | --deep | --publish | open. Trigger phrases include
  "plan page", "plan dashboard", "add a note to the plan", and "open the
  plan dashboard".
color: teal
---

# /plan-page — narrative plan visibility

The local dashboard is the authoritative zero-token view of approved native
plans, c-thru wave state, transcript activity, and todos. Your role is to add
only the useful human narrative that cannot be derived from those files.

## Find the dashboard

Resolve the proxy control-plane URL before acting:

1. If `$ANTHROPIC_BASE_URL` is set, `curl -sf "$ANTHROPIC_BASE_URL/ping"`.
2. Otherwise curl `http://127.0.0.1:${CLAUDE_PROXY_PORT:-10017}/ping`.
3. Parse the returned JSON. Its `plan_dashboard` field is the canonical URL.

If neither probe works, say plainly that no local proxy is running. You may
still explain the expected local URL, but do not claim the dashboard is live.

## Default action and `--plan`

With no argument or free text, fetch `GET /c-thru/plan` from the resolved proxy.
Choose the newest `plans[]` entry whose `repo` matches the basename of the
current working directory. `--plan <slug|snapshot-id>` overrides this: match a
wave `slug` or a native snapshot filename without `.md`. If the selection is
ambiguous, ask one short question rather than attaching a note to the wrong
plan.

Write one short narrative note to:

```text
${C_THRU_PLAN_SPOOL:-$HOME/.claude/c-thru/plan-events}/notes/<plan-key>/<epoch>.md
```

Use the wave slug as `<plan-key>` when a wave is present, otherwise the native
snapshot id. Create the directory if needed. The file must begin exactly with
YAML frontmatter followed by markdown:

```markdown
---
ts: <current ISO-8601 timestamp>
author: <active model name>
session_id: <known session id, if available>
---
What we are doing, where it stands, and any notable decision or tradeoff.
```

Keep it to a compact update. Use judgment and source context to explain what
matters; never restate the approved plan, wave item list, todos, or transcript
activity that the dashboard already renders. Confirm the note path and the
dashboard URL after writing.

## `--deep`

For `--deep`, dispatch a subagent with the Agent tool to read the selected
wave's `journal.md` and the bounded transcript tail, then write a fuller
decision-log note in the same location and frontmatter format. It should still
be narrative: decisions, rationale, changes in direction, uncertainties, and
evidence — not a duplicate plan or checklist. Report the local dashboard URL
when it finishes.

## `--publish`

For `--publish`, first prepare the local narrative note as above, then attempt
the Artifact tool to make a shareable claude.ai page. This is optional and can
be unavailable on OSS/local routing. If it fails or is unavailable, say so
plainly and provide the local `plan_dashboard` URL instead; do not fabricate a
published link.

## `open`

For `open`, print the resolved dashboard URL. On Darwin, run `open <url>` as a
convenience. Do not try to start a proxy merely to satisfy this command.
