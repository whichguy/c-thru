# Plan visibility state API

`GET /c-thru/plan` is a zero-token, file-derived JSON snapshot of approved
native plans, c-thru wave state, transcript activity, todos, and narrative
notes. The running proxy serves it to the live HTML dashboard at
`GET /c-thru/plan/dashboard` (which polls every two seconds) and to the
`/plan-page` skill, so neither consumer needs to spend tokens re-deriving state
already encoded in local files.

The response shape is:

```json
{ "ok": true, "generated_at": "<ISO-8601 string>", "plans": [] }
```

Each `Plan` contains `repo`, `cwd`, `session_id`, `last_activity_ts`, and
`joined` (a boolean), plus these nullable or collection fields:

- `native`: `null` or `{ title, plan_md, snapshot_path, approved_at }` for an
  approved native-plan event and its snapshot.
- `wave`: `null` or `{ slug, status, items, current_wave, journal_tail,
  wave_count, revision_rounds, outcome }` from c-thru wave files.
- `activity`: `null` or `{ recent, todos }`, where `recent` is an array of
  transcript tool events and `todos` is an array of the latest transcript
  todos.
- `notes`: an array of `{ author, ts, md }` narrative notes.

Plan identity uses a namespaced candidate in the dashboard (`native:<snapshot
id>` or `wave:<slug>`), while note attachment uses the corresponding raw key:
the native snapshot basename with its trailing `.md` removed, or the wave slug.
See the `/plan-page` skill for the exact note-writing rule.

To opt the approved-plan hook out entirely, set the boolean JSON key
`"plan_page": false` in `~/.claude/model-map.overrides.json`. This is checked
before the hook reads any `C_THRU_PLAN_*` environment variables.
