# Research-Driven Model-Map Updates — 2026-04-25 Tournament

This document summarizes the actionable findings from
[`tournament_2026-04-25.md`](./tournament_2026-04-25.md) (26 models × 16 roles, 507 runs)
that influence `config/model-map.json`. Source data and methodology in the tournament report.

## Best-in-class model per role (primary-role rankings)

| Role | Best local model | Quality | Speed | RAM | Currently in our map? |
|---|---|---|---|---|---|
| **Generalist** | `qwen3.6:35b-a3b` (MoE) **or** `qwen3.6:27b` | 5.0 | 60 t/s / 19 t/s | 22GB / 27GB | ❌ neither — we use `qwen3.6:35b` (dense) |
| **Coder** | `qwen3.6:35b-a3b-coding-nvfp4` **or** `qwen3-coder:30b` | 4.5 | 124 t/s | 22GB / 18GB | ✓ both routes exist |
| **Agentic Coder** | `devstral-small:2` (NOT `devstral-2`) | 3.1 | 36 t/s | 15GB | ✓ used at 128gb local_best (but see below) |
| **Debugger** | `deepseek-r1:32b` | 4.5 | 25 t/s | 20GB | ✓ used for `reasoner`/`judge` offline at 64gb+ |
| **Logic / Judge** | `phi4-reasoning:latest` (NOT `:plus`) | 3.7 / 5.0 cross-role | 43 t/s | — | ❌ not yet routed |
| **Fast Generalist** | `gemma4:26b-a4b` (MoE) | 5.0 | 103 t/s | 17GB | ✓ routed; see classifier slot |
| **Large General** | `gpt-oss:120b` | 4.5 | 78 t/s | 65GB | — |
| **Edge** | `gpt-oss:20b` | 3.8 | 112 t/s | 13GB | ✓ routed |

## Key surprises

1. **MoE > Dense at same parameter count.** `qwen3.6:35b-a3b` (MoE, 3B active) and
   `gemma4:26b-a4b` (MoE) both beat their dense counterparts on composite (quality × speed)
   while using **less RAM**. Strict win.

2. **Size inversion at 27B vs 35B.** `qwen3.6:27b` (dense) outperforms `qwen3.6:35b` (dense)
   on coder + debugger + generalist cross-role. More tokens ≠ better.

3. **NVfp4 quantization can be POSITIVE.** `qwen3.6:35b-a3b-coding-nvfp4` and `-mxfp8` pass
   C2 (binary search) at q=5.0 while the **bf16 (full precision) variant fails (q=1)**.
   Quantization changes which solution tokens are sampled — not purely a quality loss.

4. **Extended thinking hurts judge calibration.** `phi4-reasoning:plus` scored q=1 on judge
   prompts where `phi4-reasoning:latest` scored q=5. Plus took 464–1137s vs 20–38s. Use
   `:latest`, never `:plus`, for judge work.

5. **Devstral size ≠ quality.** `devstral-2` (74GB) averaged q=3.2 vs `devstral-small:2`
   (15GB) at q=3.1 — 5× the RAM for 0.1 quality difference. Always prefer `:small:2`.

6. **No good local orchestrator.** Only cloud GLM-4.6/5.1 covered the role at q≥4.0. Local
   orchestrator is a known gap — `qwen3.6:35b-a3b` is closest with cross-role coverage.

7. **Multi-role champion: Gemma-4-26B-MoE.** Only model covering 4 roles (coder, debugger,
   fast_generalist, generalist) at ≥80% threshold. 17GB RAM. Underutilized in our config —
   currently only fills `classifier` at 128gb.

## Concrete model-map.json updates

### Phase 1 — high-confidence changes (applied)

1. **Add to `model_routes`:**
   - `qwen3.6:35b-a3b` → `ollama_local` (best generalist, MoE)
   - `qwen3.6:27b` → `ollama_local` (size-inversion winner)
   - `phi4-reasoning:latest` → `ollama_local` (best judge cross-role)

2. **`workhorse` 64gb / 128gb**: switch from `qwen3.6:35b` (dense) → `qwen3.6:35b-a3b` (MoE).
   Same quality (q=5.0), 3× faster, less RAM. The dense `qwen3.6:35b` was the top change
   earlier this session per user direction; the report shows the MoE variant is strictly better.

3. **`workhorse` 32gb / 48gb offline**: switch from `qwen3.6:35b` → `qwen3.6:35b-a3b`. The MoE
   has same effective RAM but much better speed.

4. **`deep-coder` 128gb local_best**: switch from `devstral-small:2` (q=3.1) →
   `qwen3-coder-next:q8_0` (q=4.5). Coder-Next dominates on coder benchmarks.

### Phase 2 — recommended but not applied (need verification / available models)

- **`judge` offline**: consider `phi4-reasoning:latest` as an alternative to `deepseek-r1:32b`.
  Phi-4 scored q=5.0 cross-role on judge prompts (the only model to do so). DeepSeek-R1-32B
  is the best debugger but slightly weaker as judge. Evaluate per-deployment.

- **`agentic-coder`** capability: stop using `qwen3-coder:30b` (current `deep-coder` choice
  at 128gb) for agentic work — it scored q=1 on D2 (Go errgroup leak) while `qwen3-vl:8b`
  scored q=5. The "agentic" fine-tune isn't helping diagnosis-first behavior. Consider
  `devstral-small:2` for agentic specifically.

- **`fast_generalist`** could be promoted: `gemma4:26b-a4b` (MoE) covers 4 roles at ≥80%
  with only 17GB RAM. Worth promoting from classifier-only to a primary role at 32gb/48gb
  where it's the best multi-role fit.

### Phase 3 — known gaps (not in report, captured for future work)

- **No good local orchestrator** — all-cloud (GLM-4.6/5.1). Need a local fallback.
- **Long-context fails on the only candidate** — `llama4:scout` timed out at 50K tokens.
  Need either a longer timeout (600s+) or a different model.
- **Vision and PDF roles entirely unwired** in our `agent_to_capability` map.

## What NOT to use (avoid in future configs)

- `phi4-reasoning:plus` — extended thinking actively *hurts* on calibration tasks
- `devstral-2` (74GB) — barely better than `:small:2` (15GB)
- `qwen3.6:35b-a3b-coding-bf16` — fails C2 where smaller-precision quantizations pass
- `llama4:scout` for long_context — practical throughput too low for 50K+ contexts
- `gpt-oss:*` for provenance-sensitive work — health check hallucinations (claim to be OpenAI)

## Verification

```sh
# After applying Phase 1 changes
node tools/model-map-validate.js config/model-map.json
node test/proxy-active-models.test.js
```
