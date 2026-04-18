# TODO: Reconsider model rewriting in user hooks vs proxy

## Observation

Proxy logs (`~/.claude/proxy.log`) are being written even when a session is
not routed through c-thru. Likely source: user-level hooks (`~/.claude/hooks/`
or settings.json `UserPromptSubmit` / other events) that rewrite or inspect
the model name on every request — not just c-thru-routed ones.

## Question

Is user-hook-side model rewriting earning its keep, or should we delete it
and let the proxy own all routing?

**Case for proxy-only:**
- Proxy has the full `model-map.json` (routes, backends, fallback_strategies).
- Proxy sees the resolved `effectiveModel` and backend capabilities — more
  context than a hook that only sees the request body.
- Single source of truth for model aliasing; no drift between hook logic
  and `config/model-map.json`.
- Non-c-thru sessions stop paying the cost (and stop dirtying the log).

**Case for hook-side rewriting (to investigate):**
- Are hooks doing anything the proxy *can't* do (e.g., injecting context,
  classifying intent to *pick* a route before the proxy sees it)?
- Is hook rewriting the only place a specific convenience alias lives?

## Action items

1. Inventory user hooks touching model names — grep `~/.claude/hooks/` and
   `~/.claude/settings.json` / `~/.claude/settings.local.json` for
   model/route manipulation.
2. For each one, classify: (a) redundant with proxy, (b) adds value the
   proxy can't, (c) feeds the proxy (pre-routing classification).
3. Delete (a). Migrate (b) into the proxy if feasible. Keep (c) but
   verify it exits cleanly when the session isn't c-thru-routed (so the
   proxy log isn't touched).
4. Confirm fix: run a non-c-thru Claude Code session and verify
   `~/.claude/proxy.log` mtime doesn't advance.

## Related

- `c-thru-classify.sh` (UserPromptSubmit hook → `/hooks/context` on port
  9998) — classifier context injection. Confirm it no-ops when proxy
  isn't running.
- `c-thru-proxy-health.sh` — should already no-op on non-c-thru sessions.
- `CLAUDE.md` at repo root describes the three hooks; verify scope.
