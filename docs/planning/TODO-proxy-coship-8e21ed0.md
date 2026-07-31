# TODO / audit: proxy co-ship in `8e21ed0`

**Commit:** `8e21ed0` (`fix(stats/statusline): lifetime clear UX, slim feed, durable bar enable`)  
**Date:** 2026-07-31  
**Scope note:** Commit message is stats/statusline-centric; `tools/claude-proxy` delta was ~1000+/141− and mixed residual work with unrelated translation/cache changes.

## Classification

| Area | Residual (stats/statusline)? | Covered by | Risk | Recommend |
|---|---|---|---|---|
| `GET /c-thru/statusline` + session `RECENT_REQUESTS` filter | **Yes** | `test/proxy-statusline-endpoint.test.js` | Low | Done |
| Usage clear / clear-wins / usage ledger (adjacent) | **Yes** (UX + tests) | `proxy-usage-stats`, `proxy-control-auth` | Low | Done |
| OpenAI Responses **reasoning cache** helpers | No | `proxy-responses-reasoning-cache`, openai-translation | Med process | Leave; already tested |
| `mapAnthropicToOpenAI*` restructure (image/tool/thinking) | No | `proxy-openai-translation`, live-shapes | Med | Leave |
| Claude Code **correlation** scrub/preserve | No | xAI scrub assertions; + dedicated suite (P4) | Med privacy | Hermetic matrix |
| `resolveBackend(..., preferAgentModelPin)` | No | brand/pin / agent routing suites | Low–Med | Confirm when next touching routing |
| Gemini mapping / usage path churn | No | `proxy-gemini-*` | Low–Med | Leave |
| Telemetry path helpers | No | journal / usage-adjacent | Low | Leave |

## Follow-ons

1. **Do not** history-rewrite `8e21ed0` unless explicitly requested.  
2. Prefer not mixing OpenAI/Gemini translation work into statusline commits.  
3. Optional: dual lifetime/session counters remain **product D2 deferred** (see bottom).  

## Dual counters (C0) — deferred design sketch

Residual product **D2** remains: v1 has no dual session counters; reset is global clear of the lifetime ledger.

If product reopens D2 later:

- Keep file `usage-stats.json` lifetime totals + `cleared_at`.  
- Add in-process (or session-keyed) window counters reset on clear and optionally `STATS_RESET=launch`.  
- Statusline Σ needs an explicit product choice: lifetime vs window (or both chips).  
- Do not change multi-proxy merge protocol without a dedicated design.

**Status:** design only — not implemented in residual-pending completion.
