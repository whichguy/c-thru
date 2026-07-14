# c-thru Implementation-Completeness Verification

> Forward coverage (requirements → code): does each capability in
> [functionality-map.md](functionality-map.md) actually hold, including corner cases? Verdicts below were
> produced by reading current code + tests live (not the prior audit, which is stale — see note). Each row:
> **implemented** {full/partial/none} · **test-covered** {yes/partial/no} · **corner-cases** {yes/no} ·
> **GAP**.

## ⚠ The prior audit is stale

`docs/test-coverage-audit.md` (dated 2026-04-26) was written against a ~1300-line `claude-proxy`; the file
is now ~4939 lines. **Every HIGH-priority gap it named has since been implemented and test-covered,
except `sessionEffectivePath` collision detection.** Treat `test-coverage-audit.md` as a historical
snapshot; this file supersedes it for current state.

This file itself is a dated verdict snapshot, not a process doc — see `docs/review-methodology.md`
for how to run a review round that would refresh it, and `docs/test-authoring.md` for how to
write the tests that close a GAP row.

---

## 1. Proxy core — the prior audit's HIGH-priority items, re-verified live

| Function | implemented | test-covered | corner-cases | GAP |
|---|---|---|---|---|
| `parseCliFlags` (`claude-proxy:46`) | full | yes (`proxy-cli-flags.test.js`) | yes | none — `=`/space/missing-value/unknown all handled + tested |
| `forwardOllama` (`forwardOllamaLegacy:3974` + `setupOllamaStream:1968`) | full | yes (`proxy-runtime-fallback` T8, `proxy-client-disconnect-cleanup`, `proxy-forward-ollama-midstream-error`, `proxy-streaming-ollama`) | yes | minor: `handleOllamaNonStream` JSON-parse failure (`:2437`) returns 502 but records no usage (harmless — no tokens); untested |
| `tryFallbackOrFail` (`:1525`) | full | yes (`proxy-runtime-fallback` T6/T9/T10/T15) | yes | minor: no test crafts a literal A→B→A mutual-cycle config; `MAX_FALLBACK_HOPS=20` boundary not exercised at +1 |
| `resolveBackend` (`:975`) | full | yes (`proxy-resolution-matrix`, `proxy-tier-resolution`, `resolution-coverage`) | partial | minor: missing-capability-profile **503** (`:1080`) is covered only by a static invariant test, not a runtime drive |
| `recordUsage` (`:443`) | full | yes (`proxy-usage-stats` A/B) | yes | none — debounce + lock + atomic-rename + clear-wins reconciliation all present |
| `sessionEffectivePath` (`model-map-config.js:19`) | **partial** | **no** | **no** | **the one genuinely-open item**: `md5(project:profile).slice(0,12)` temp path with no collision/stale-file guard, and the fn is **not exported** so it's untested. Probability negligible (48-bit, per-machine tmpdir); a `{project_path}` provenance check + mismatch-regenerate would close it |

## 2. Wire-translation completeness (map flagged "partial" — confirmed, here's why)

| Translator | implemented | test-covered | Notes |
|---|---|---|---|
| Anthropic passthrough | full | yes | verbatim; tool_use/tool_result/thinking native |
| Anthropic⇄Ollama-legacy | full (lossy **by design**) | yes (`proxy-streaming-ollama`) | `flattenMessagesForOllama:1395` keeps only `type:text`, dropping tool_use/image/document — documented tradeoff for Ollama <0.4 / LM Studio |
| Anthropic⇄Gemini | full | yes (`proxy-gemini-translation` 212, `…-live-shapes` 105, `…-routing` 134) | full bidirectional incl. thoughtSignature round-trip, schema scrub, thinking-budget |
| Anthropic⇄OpenAI | **stub (501)** | n/a | `call_style:openai` returns 501 enumerating the 4 unbuilt mappings (`:4844`); `normalizeBackend` warns at load (`:716`) — **intentional** |
| Bedrock | **absent** | n/a | no code at all (see §5) |
| Vertex | full (Gemini reuse) | yes | URL/auth variant of the Gemini path (`backend.vertex`, `:2973`); **no SigV4 / Converse** |

**"Partial" verdict explained:** translation is partial *only* because OpenAI is a deliberate stub and
Bedrock is absent. The two implemented non-passthrough translators (Ollama-legacy, Gemini) are themselves
complete.

## 3. Model-map config — the "partial" capabilities, re-verified

| Capability | implemented | test-covered | corner-cases | GAP |
|---|---|---|---|---|
| 3-tier (layer) resolution corner cases (missing tier, unknown mode/model, fallback-to-default) | full | yes (`resolve-capability`, layer-precedence integration) | yes | none for resolution; **doc** `model-map.md` schema corrected to capability-outer in 0345fb8 |
| Intent / dynamic role classification | **none** | no (test **excluded** in `run-all.sh:312`) | yes (verified absent) | **severe doc/code divergence** — see §4a |
| `recommended-mappings` + apply-recommendations | **RETIRED** | n/a (feature removed in this audit) | yes | was **dead vs shipped data** — config + apply tool + `--rec` flag removed; see §4b |

## 4. Doc-says-shipped / code-says-absent divergences (the substantive findings)

### 4a. Dynamic role classifier — absent from code (doc/script wording corrected in 0345fb8)
- The role classifier (`CLAUDE_PROXY_CLASSIFY`, `classifyRole()`, `x-c-thru-classified-role`) is **not in
  `tools/claude-proxy`** (`grep classifyRole` → nothing; only unrelated `classifyFailure`). The symbol
  exists only in `test/proxy-classify.test.js`, which `test/run-all.sh:312` **explicitly excludes** with
  the comment *"CLAUDE_PROXY_CLASSIFY feature not implemented in proxy."* `docs/dynamic-classification-phase-a.md`
  previously marked it **"shipped"**; 0345fb8 re-marked it *proposed / not yet implemented*.
- The `/hooks/context` endpoint is **event-split by body shape**, not a model classifier:
  non-empty `prompt` (UserPromptSubmit / `c-thru-classify`) → **short** control-plane block;
  SessionStart/PreCompact/empty → **long** (adds a brief when-to-query blurb). No
  `classify_intent` / no LLM call on this path. The script header correctly states there
  is no intent classification; token cost is controlled by not growing the UPS payload.
- **Status: event-split shipped** (short vs long). Full intent classification remains
  intentionally unimplemented.

### 4b. `recommended-mappings.json` — schema-mismatched, apply is a permanent no-op  → **RETIRED in this audit**

> **Resolution (decision: retire the feature).** `config/recommended-mappings.json`,
> `tools/model-map-apply-recommendations.js`, the `tools/c-thru` apply step, the `install.sh`
> `apply_recommendations` step, and `model-map-validate.js`'s `--rec` path /
> `validateRecommendedMappings` export were all removed. `c-thru explain`'s `is_recommended`
> output field is kept (hardcoded `false`) for output-schema stability. The analysis below is
> retained as the rationale for the removal.

- `config/recommended-mappings.json` capability names (`judge, orchestrator, local-planner, deep-coder,
  code-analyst, pattern-coder`) **do not exist** in shipped `llm_profiles` (`planner, coder, tester, …`).
  `applyRecommendations` guards on cap existence (`model-map-apply-recommendations.js:53`) → running it
  against the real config yields **`applied 0`**. The whole community-recommendations feature is dead.
- It also injects only into `best-local-oss` yet recommends `claude-opus-4-8` (a cloud model) for `judge`
  — a semantic contradiction in a no-cloud-egress mode.
- `validateRecommendedMappings` (since removed) **could not catch this** — it derived caps from the rec
  file itself (which had no `llm_profiles`), falling back to hardcoded keys; and `--rec` was wired into no
  gate. `applyRecommendations` had no direct test.
- **Fix (non-trivial — go/no-go):** either rewrite `recommended-mappings.json` to real capability names
  (and a local model for local modes), or formally retire the feature; and if kept, gate
  `model-map-validate --rec` so the mismatch can't recur.

## 5. Bedrock default-URL requirement (task #20) — N/A, premise absent

**Verdict: cannot HOLD/not-HOLD — there is no Bedrock backend to govern. Premise verified live: yes.**

- No bedrock endpoint in `config/model-map.json` (endpoints are `anthropic`, `openrouter`, `ollama_local`,
  `ollama_cloud`, `gemini_ai`, `gemini_vertex`, `anthropic_subscription`).
- No `CLAUDE_CODE_USE_BEDROCK` / `USE_BEDROCK` / `AWS_REGION` / `AWS_BEARER_TOKEN_BEDROCK` /
  `bedrock-runtime` / `amazonaws` anywhere in `tools/` or `config/`.
- Bedrock appears only as an aspirational doc-comment at `tools/c-thru:14`.
- Base-URL selection is purely `ANTHROPIC_BASE_URL`-driven: `apply_provider_block` →
  `export ANTHROPIC_BASE_URL="$base_url"` (`tools/c-thru:4337`), `$base_url` taken verbatim from the
  resolved endpoint `.url`. No AWS/SigV4/Bedrock branch. A `bedrock-*` model today would match no endpoint
  and fall through to the "assume Ollama" guardrail (`:4506`) — it would fail, never reaching
  `api.anthropic.com`.

**Therefore #20 is a feature request, not a fix.** To make it actionable: add Bedrock as an endpoint
(format/kind, regional URL, SigV4 auth) in `config/model-map.json` + a branch in `apply_resolved_backend`,
and a Bedrock wire translator in the proxy (Converse/InvokeModel — currently absent). Only *then* does the
"default ANTHROPIC_BASE_URL to the Bedrock endpoint when a Bedrock override is present" rule have meaning.
**Awaiting go/no-go on whether to spec + build it.**

## 6. Injection conformance (P3) — detail

Full 13-point classification is in [functionality-map.md §2](functionality-map.md#2-injection-layer-user-design-priority).
**Conformance: full** — 12/13 inline-or-necessary-IPC, 1 necessary isolation dir, **0 avoidable
file writes**:

- **#10 ephemeral settings → inline `--settings` (converted).** `write_ephemeral_settings` now builds the
  settings JSON into the `EPHEMERAL_SETTINGS_JSON` shell var, and `build_forwarded_args` passes it inline as
  `--settings "$json"` — no temp file. The blocker resolved in c-thru's favor: Claude Code 2.1.177's
  `--settings` accepts "a JSON file path **or** a JSON string", so the inline form is supported. Verified by
  `test/cli-e2e-flags.test.js` Test 18 (inline arg parses + correct SessionStart-hook shape) and Test 20
  (the durable `~/.claude/settings.json` stays byte-identical and mtime-unchanged across a launch).
- **#11 ephemeral profile dir** is necessary isolation (no inline equivalent for a whole `CLAUDE_CONFIG_DIR`).

*(Injection #10 converted to inline; #11 remains necessary isolation. No further conformance gaps.)*

---

## Disposition summary (what needs a decision)

| Item | Type | Recommended action | Gate |
|---|---|---|---|
| `sessionEffectivePath` collision guard | code gap (negligible prob) | add provenance check, or accept-as-is with a note | go/no-go |
| OpenAI 501 stub | intentional | document as roadmap, no action | — |
| Dynamic-classification-phase-a "shipped" claim | doc bug | **FIXED** 0345fb8 (re-marked proposed/unimplemented) | done |
| `c-thru-classify.sh` header comment | doc bug | **FIXED** 0345fb8 (header corrected) | done |
| `recommended-mappings.json` mismatch | dead feature | **RETIRED** (config + apply tool + `--rec` removed) | done |
| proxy-health exit-2 claim (CLAUDE.md:59 + script comment) | doc bug | **FIXED** 0345fb8 (corrected to "always exit 0") | done |
| `model-map.md` stale schema | doc drift | **FIXED** 0345fb8 (capability-outer schema) | done |
| Bedrock backend (task #20) | feature | spec + build, or close #20 | go/no-go |
| Injection #10 → inline `--settings` | conformance polish | **DONE** (converted to inline JSON string) | done |
