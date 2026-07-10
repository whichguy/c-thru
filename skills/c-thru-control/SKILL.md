---
name: c-thru-control
description: |
  Agentic infrastructure control for c-thru. 
  Interrogate the proxy for hardware status, active models, and connectivity health.
  Dynamically switch routing modes (connected, offline, etc.) using natural language prompts.
---

# /c-thru-control — Runtime Infrastructure Control

This skill provides a "control channel" to the `c-thru` proxy, enabling both human and agentic control over the AI routing layer.

## Quick Start (Natural Language)

You can use natural language prompts to control the proxy. The skill interprets your intent and maps it to the underlying REST API.

**Usage:** `/c-thru-control <intent prompt>`

- `/c-thru-control how are we running?` (Status check)
- `/c-thru-control go offline` (Switch to `best-local-oss`, fully local)
- `/c-thru-control switch to connected and save` (Persistent mode switch)
- `/c-thru-control refresh the config` (Reload from disk)

```bash
"$REPO_ROOT/tools/c-thru-control" "$ARGUMENTS"
```

---

## Logical to REST Specification

For the AI agent's situational awareness, here is the mapping from logical intents to the proxy's control channel API:

| Intent (Logical) | Method | Path | Payload |
|---|---|---|---|
| **Interrogate Status** | `GET` | `/c-thru/status` | N/A |
| **Inspect Recent Requests** | `GET` | `/c-thru/recent?n=<N>` | N/A — newest-first ring of recent requests: requested→served model, backend, tokens, latency, errors, fallbacks |
| **Open Stats Dashboard** | `GET` | `/c-thru/dashboard` | N/A — live HTML dashboard (give the user the URL; also in `dashboard_url` of `/c-thru/status`) |
| **Set Connectivity Mode** | `POST` | `/c-thru/mode` | `{"mode": "<mode_name>"}` |
| **Reload Config** | `POST` | `/c-thru/reload` | N/A |

### Valid Modes:
5 canonical modes: `best-cloud`, `best-cloud-oss`, `best-local-oss`, `best-cloud-gov`, `best-local-gov`.

Legacy aliases also accepted: `connected` (→ `best-cloud`), `offline`/`disconnect` (→ `best-local-oss`). Any name outside this set — including `local-only`, `semi-offload`, `cloud-judge-only`, `fastest-possible`, and other names from c-thru's earlier 15-mode design — gets rejected with HTTP 400 by `POST /c-thru/mode`, unless it's been declared as a `custom_modes` key in `model-map.json`.

---

## Agentic Heuristics (When to use this skill)

The AI agent should use this skill autonomously in the following scenarios:

1.  **Massive Scale Failover**: If tasked with processing >50 files or a complex architectural refactor, use `/c-thru-control go offline` to preserve cloud tokens and utilize the `workhorse` local model.
2.  **Network Resilience**: If you encounter persistent HTTP 429 (Rate Limit) or 503 (Service Unavailable) from the primary provider, use `/c-thru-control go offline` to failover to local hardware seamlessly.
3.  **Tier Awareness**: At the start of a session, use `/c-thru-control status` to determine if you are running on a `128gb` workstation or a `16gb` laptop, and adjust your reasoning depth accordingly.
