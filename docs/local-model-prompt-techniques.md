# Local Model Prompt Techniques & Community Findings

Research compiled from Reddit (r/LocalLLaMA), HuggingFace discussions, GitHub issues (ollama, llama.cpp, lmstudio), and community blogs. Covers models active in `config/model-map.json` as of 2026-04-21. **Scope: client-observable behavior through the Ollama API (or generically applicable), prompting patterns, request parameter behavior, response format, known failure modes, and best practices.** Server deployment configuration is excluded; internal mechanics are mentioned only where they explain a client-visible behavior.

---

## Qwen3 / Qwen3.5 / Qwen3-Coder Family

### `/think` vs `/no_think` — Ollama Inconsistency

**Tags work inconsistently in Ollama, reliably in transformers.** The `/no_think` tag (or `"think": false` API param) fails to suppress thinking in several Ollama versions. Issue #12917 documents qwen3:4b ignoring all three suppression methods (the version "0.12.9" cited in the report is likely a nightly/pre-release build identifier — standard Ollama versioning does not produce this number). **The issue is CLOSED** — the reporter's resolution was switching to the `qwen3:4b-instruct` non-thinking variant released in the 2507 update; Ollama did not patch `/no_think` for base thinking models. The instruct variant is the correct workaround.

**Thinking + tools = empty output.** Passing tool definitions alongside `think=true` to qwen3:30b-a3b produces `"content": ""` (issue #10976). Disable thinking when tools are active.

**Empty `<think></think>` tags persist even in no-think mode.** Even when thinking is successfully disabled, models emit `<think></think>` empty tag pairs. These corrupt JSON/structured output pipelines if not stripped. Must be handled at the consumer level.

**Multi-turn context contamination.** In multi-turn conversations, `<think>...</think>` blocks from previous assistant turns must be stripped before re-injecting into the next prompt. **Ollama's own Jinja2 chat template handles this automatically** (issue #10448 is CLOSED — Ollama addressed it in the template). The issue primarily affects frameworks that bypass Ollama's template layer and construct prompts manually (LangChain, OpenAI SDK direct calls, custom clients). If you use `/api/chat` through Ollama normally, this is handled. If you assemble prompts outside Ollama, strip `<think>...</think>` blocks manually.

**Budget control is transformers-only.** The `ThinkingTokenBudgetProcessor` (force-inject `\n</think>` at a token limit) only works via `transformers.pipeline()`. No Ollama-native equivalent. ([muellerzr.github.io](https://muellerzr.github.io/til/end_thinking.html), [HF discussion #24](https://huggingface.co/Qwen/Qwen3-32B/discussions/24))

**Small models (1.7b–9b) default to non-thinking mode.** Qwen3:1.7b runs non-thinking by default. `/think` must be explicitly enabled — the reverse of what most people assume.

**Security: mode control in user turns is a state hijack vector.** `/no_think` in any user turn persists across the entire subsequent conversation. Mode directives belong in system prompt, not user turns. ([lukaszolejnik.com](https://blog.lukaszolejnik.com/prompt-injection-and-mode-drift-in-qwen3-a-security-analysis/))

---

### System Prompt Behavior

**Qwen3.5 requires a substantial system prompt or enters a reasoning death spiral.** Without a proper system prompt, Qwen3.5 loops: "Wait, I'll check if I should use a table... Wait, I'll check if I should use a bullet list...". Claude Opus or Gemini system prompts used verbatim work as a reasonable starting baseline. ([HN #47201388](https://news.ycombinator.com/item?id=47201388))

**System prompts interfere with thinking in Qwen3.5 specifically.** GitHub issue #18799 (opencode) reports system prompts blocking Qwen3.5's thinking process — separate from the loop behavior above.

**Embedding critical instructions in the user turn works more reliably** than system-prompt-only placement for Qwen models. ([HN #43828875](https://news.ycombinator.com/item?id=43828875))

---

### Penalty Sampling: Silently Ignored in Ollama Go Runner

**Penalty sampling was silently discarded for Qwen3.5 in Ollama — fixed in v0.17.5.** `repeat_penalty`, `presence_penalty`, and `frequency_penalty` were silently ignored for all Qwen3.5 models in older Ollama versions. Fixed in v0.17.5 (PR #14537). **You must re-pull qwen3.5 models after upgrading** — without re-pulling, old model state persists and penalties are still ignored. On v0.17.5+ with a fresh pull, penalty params are applied. Issue #14493 remains open for tool-calling bugs. ([issue #14493](https://github.com/ollama/ollama/issues/14493), [PR #14537](https://github.com/ollama/ollama/pull/14537), [v0.17.5 notes](https://github.com/ollama/ollama/releases/tag/v0.17.5))

---

### Temperature / Sampling Recommendations

Official recommendations corrected by community testing:

| Model / Task | temp | top_p | top_k | Notes |
|---|---|---|---|---|
| qwen3:1.7b (classify/commit) | 0.0–0.2 | 0.8 | 20 | No think; schema constrained; penalties silently ignored |
| qwen3.5:9b (coding, no-think) | 0.7 | 0.8 | 20 | v0.17.5+: penalty params now applied; must re-pull model. Pre-v0.17.5: silently ignored |
| qwen3.5:35b-a3b coding (thinking, **precise** coding) | 0.6 | 0.95 | 20 | presence=0 specifically for precise coding in think mode; NOT the general thinking default |
| qwen3.5:35b-a3b coding (thinking, general) | 1.0 | 0.95 | 20 | higher temp for thinking; presence_penalty=1.5 now applied on v0.17.5+ (re-pull required) |
| qwen3.6:35b (judge/orchestrator) | 0.7 | 0.8 | 20 | thinking ON by default — send `think:false` to disable; Go runner penalty status for 3.6 not directly confirmed |
| qwen3-coder:30b | 0.7 | 0.8 | 20 | use repetition_penalty=1.05 (not presence_penalty) |

One community practitioner found 0.1–0.2 necessary to prevent hallucinated variable names at higher temps; the 0.6 recommendation for coding+thinking may be optimistic for deterministic code.

**Greedy decoding (temp=0) causes infinite repetition loops in MoE models.** Official docs suggest `presence_penalty` to escape. On Ollama v0.17.5+ (with model re-pulled), this now takes effect for Qwen3.5. On older installs it was silently ignored — in that case the only mitigation is stay at temp >= 0.3.

---

### JSON / Structured Output

**Use Ollama `format` schema, not prompt-only instructions.** Schema enforcement via the `format` API parameter is more reliable than telling the model to "return JSON."

**Thinking mode + structured output = broken JSON.** Issue #10929 documents `{"{"` (duplicated opening brace) when thinking is active alongside Ollama structured output. Disable thinking when structured output is required. Likely affects qwen3:1.7b as well.

**Schema complexity matters.** Flat schemas (string/integer/boolean/array) work reliably; deeply nested/recursive schemas fail more often.

**Combine**: `format` schema + "respond in JSON only" + "do not include commentary" for best results.

---

### qwen3.6:35b (MoE — Judge/Orchestrator/Planner) Specifics

**⚠️ CORRECTION: Thinking mode is ON by default.** The original research claimed this model has no thinking mode — that is wrong. The official HuggingFace model card states: "Qwen3.6 models operate in thinking mode **by default**, generating thinking content signified by `<think>\n...</think>\n\n` before producing the final responses." The Ollama library page lists "thinking" as a supported capability tag. This is a hybrid reasoning model — explicitly disable thinking with `think: false` in the request body (via Ollama `/api/chat`) when you do not want thinking overhead. The same thinking+tools empty-output bug (issue #10976) likely applies.

**Repetition spirals with long context + YaRN.** HF discussion #23 documents severe repetition when YaRN position interpolation is enabled past the native context window. Mitigation: stay within native context window, use `frequency_penalty=0.1`. Note: penalty application depends on runner — verify it's not on the Go runner.

**Reframe negation as positive constraints.** "Don't repeat yourself" generates more repetition (activates repeat-related tokens). Use "vary your phrasing" instead.

**128 total experts, 8 activated per token, no shared experts.** More sparse than Qwen2.5-MoE. Unusual prompt styles or very long contexts are more likely to activate unexpected expert combinations, producing inconsistent behavior.

---

### qwen3-coder:30b (Deep-Coder on 128gb) Specifics

**Different tool-calling format.** qwen3-coder uses XML-style tool calls, not JSON (Hermes style). Ollama previously wired Qwen3.5 to the wrong (Hermes JSON) pipeline — **fixed in Ollama v0.17.6** (PR #14605, `jmorganca`). On v0.17.6+, both Qwen3.5 and qwen3-coder use the correct `Qwen3CoderRenderer`/`Qwen3CoderParser` (XML) pipeline. Some community reports of tool-calling issues persist after v0.17.6 (issue #14493), but the format mismatch itself is resolved. ([issue #14493](https://github.com/ollama/ollama/issues/14493), [PR #14605](https://github.com/ollama/ollama/pull/14605))

**Tool calling in Ollama is unreliable.** Unsloth GGUF discussion #10 documents persistent failures: "Does not support tools" errors, tool calls failing silently or looping. Alternative: llama.cpp server with `--jinja --chat-template-file qwen3-coder.jinja`, or LM Studio.

**Thinking mode is supported** (as is qwen3.6:35b — both support thinking). Same thinking+tools interaction bug from issue #10976 likely applies — test before combining.

---

## Gemma 4 Family

### Critical Bug: Empty Response on System Prompt >500 Characters

**Gemma4:26b (MoE only) returns a completely empty response** — no content, `done_reason: "stop"` after ~49 tokens — when the system prompt is long. The reporter in issue #15428 estimates the threshold at roughly 500 characters (prompts under ~200 chars work; a 2000-char prompt fails). **⚠️ Disputed:** one GGUF vendor (rparo20) was unable to reproduce across five configurations including 1.8–10 KB system prompts; separately, Ollama collaborator `rick-github` reproduced the same scenario at Ollama 0.20.3 and received a full valid response (`eval_count: 314`) — suggesting this may be GGUF-variant or quant-source specific. The issue is labeled "needs more info" with no confirmed root cause from Ollama maintainers. See also the Authoritative Corrections section. Dense models (31b, e4b) handle the same prompt correctly — the MoE-only nature is confirmed. ([issue #15428](https://github.com/ollama/ollama/issues/15428))

**All agentic worker system prompts in this stack will likely hit the failure range.** The 26b model is mapped to `workhorse` and `reviewer` roles on 48gb/64gb tiers. Treat `gemma4:26b` as unreliable for agentic roles until reproduced or fixed. Use `gemma4:31b` for these roles, or verify `gemma4:26b-mxfp8` independently (behavior unconfirmed).

---

### Chat Template Issues

**Double-BOS risk.** If a custom GGUF import prepends an extra BOS token on top of the one already in the Gemma 4 chat template, responses degrade into repetitive/garbage output. `ollama pull` handles this correctly; symptom of the problem is immediate incoherence from turn 1.

**New thinking tokens.** Gemma 4 adds native `<|think|>` reasoning tokens in the chat template. This is new; Gemma 3 had no thinking mode. Every system using Gemma 3 templates must be audited.

---

### Thinking Mode / OpenAI-Compat Endpoint

**OpenAI compat endpoint broken for thinking models.** When using `/v1/chat/completions`, all model output lands in the `reasoning` field and `content` is empty. The `think` parameter is only supported on native `/api/chat`. Any client using the OAI-compat path (LangChain, OpenAI SDK) will receive empty content. Use native Ollama `/api/chat` with `"think": false`.

**Thinking must NOT be stripped between tool calls.** When a single model turn involves tool calls, thinking tokens must be preserved between function calls — the model loses reasoning context needed to complete the chain. Gemma 4-specific behavior documented by Google.

**E2b/e4b thinking template bug.** On LM Studio 0.4.11, disabling thinking for e2b and e4b causes thinking output to appear directly in chat. Jinja template regression. Ollama ships its own template so may not be affected — test independently.

---

### Flash Attention: Disable for Gemma 4

**FA is off by default for all Gemma 4 in Ollama** — and that is the correct state. Ollama maintainer `dhiltgen` enabled FA (PR #15296) then reverted it (PR #15311) after benchmarking a **41.8% throughput degradation** across all Gemma 4 variants with FA on. The revert is the current shipped behavior. Do not enable FA for any Gemma 4.

**The 31b Dense hang is a separate, worse issue.** `gemma4:31b` specifically hangs indefinitely above a prompt-length threshold with FA enabled — gemma4:26b does not hang, but still degrades 41.8% in throughput. Do not enable FA for any Gemma 4 variant; the Ollama team intends to ship a correct implementation but has given no timeline. ([PR #15311](https://github.com/ollama/ollama/pull/15311), [issue #15368](https://github.com/ollama/ollama/issues/15368))

---

### JSON / Structured Output — Regression from Gemma 3

**Grammar-constrained JSON generation is highly unreliable via Ollama `format=`.** The failure modes differ by model:
- `gemma4:31b`: **60–100% failure rate** (39 trials in issue #15502) — repetition collapse: collapses into word-doubling then single-token loop, leaves JSON unterminated
- `gemma4:26b-a4b`: separate bug — malformed JSON structure (not repetition collapse); 40–100% across test conditions in companion issue #622
- `repeat_penalty` at 1.0, 1.15, and 1.5 has no effect on either failure mode
- `gemma3:27b` is clean (0/10 failures on the same tests)

**⚠️ Critical attribution:** Issue #15502 confirms the 31b repetition-collapse bug is **Ollama's grammar sampler**, not model weights — the same GGUF runs 0/10 failures on `llama.cpp-server` with identical grammar constraints. This is an Ollama-specific bug, not a fundamental model capability limitation.

This is a regression from Gemma 3. **Do not use Ollama `format=` grammar constraints with any Gemma 4 variant.** Use prompt-level enforcement: "Return exactly one JSON object. Do not wrap in markdown. Do not include explanation text outside JSON."

**`<unused24>` token runaway.** The 26B-A4B GGUF can enter a loop producing `<unused24><unused24>...` tokens. Fix merged in llama.cpp b8702; check Ollama version. ([llama.cpp issue #21321](https://github.com/ggml-org/llama.cpp/issues/21321))

---

### e2b / e4b "Efficient" Variants

**Not MoE.** "E" stands for Efficient (edge/mobile deployment), not a mixture-of-experts architecture. The `26b-a4b` is the MoE (26B total, 4B active). e2b/e4b are dense edge models.

**Significant quality gap from 26b/31b.** Community scoring: e2b ~60/100, e4b ~72/100, 26b-a4b ~85/100, 31b ~90/100. Not reliable substitutes for 26b in agentic/structured output roles.

**e4b tool-calling: confirmed unreliable by Ollama contributor.** Issue #15315 shows that even after PR #15254 fixed the quoted-string parser crash for 26b/31b, `gemma4:e4b` continued to produce tool parsing errors on Ollama 0.20.1. Ollama contributor `drifkin` acknowledged: *"Sometimes very small models will make mistakes in tool calling, but perhaps there are some other issues at play, we'll investigate."* Issue remains open. Do not rely on e4b for tool dispatch; use 26b or 31b. ([issue #15315](https://github.com/ollama/ollama/issues/15315))

---

### Context Window Reality

**Context windows differ by variant — confirmed by Google's official model card.** e2b and e4b: **128K** max. 26b A4B and 31b: **256K** max. The common generalization "Gemma4 has a 256K context window" is only true for the two larger models. Setting `num_ctx` above 128K for e2b/e4b exceeds the model's training context. ([Google model card](https://ai.google.dev/gemma/docs/core/model_card_4))

**26b-a4b MRCR long-context benchmark: 44.1% at 128K.** 31b scores 66.4% on the same 8-needle retrieval test. The 26b model is significantly weaker on long-context retrieval even when hardware supports it.

**Practical degradation past 32K on 16GB VRAM.** Even where 256K is supported, inference quality degrades past 32K under memory pressure. Keep effective context under 32K for 26b unless 24GB+ VRAM with headroom.

---

### Gemma 4 Failure Summary

| Failure | Affects | Severity | Workaround |
|---|---|---|---|
| Empty response on long system prompt | `26b` MoE — **disputed**: Ollama collaborator could NOT reproduce (got valid response); "needs more info" | Unconfirmed — treat as possible | Use `31b` as safer default for agentic roles |
| Ollama grammar sampler JSON failure (31b: repetition collapse 60–100%; 26b: malformed JSON) | `31b`, `26b` — different failure modes | Critical — Ollama GGML sampler bug; clean on llama.cpp-server | Avoid `format=`; use prompt-level enforcement |
| `/v1/chat/completions` streaming: output in `reasoning` field, `content` empty | All Gemma 4 | High | Route to native `/api/chat`; pass `think:false` |
| `<unused24>` token runaway | `26b-a4b` GGUF | High | Update Ollama (llama.cpp b8702 fix) |
| FA: 41.8% throughput degradation (all variants) + hang for 31b Dense | 31b hang confirmed; throughput degradation all variants | High — FA off by default post-revert PR #15311 | Do not enable FA (off by default post-revert) |
| Tool-call parser crash (mode 1: quoted-string arg) | `e4b` still broken (issue #15315); `26b`/`31b` fixed in PR #15254 | High for e4b | Mode 1: use `26b` or `31b`. Modes 2–3 (streaming in reasoning field; `<unused25>` token) remain open for all variants — use llama.cpp-server; no Ollama fix yet |
| Thinking leaking into response body | `e2b`, `e4b` | Moderate | Use Ollama native endpoint; verify template |
| Double BOS token | All GGUF variants | Moderate | Verify Ollama handles correctly |

---

## gpt-oss:20b (OpenAI Open-Weight MoE)

21B total params / 3.6B active, MXFP4, Apache 2.0. Used in reviewer, orchestrator, deep-coder roles.

### Chat Format: Harmony (Not ChatML)

gpt-oss uses OpenAI's proprietary **Harmony** format — not ChatML or `[INST]`. Structured wire format with named channels and control tokens: `<|start|>`, `<|end|>`, `<|message|>`, `<|channel|>`, `<|call|>`.

Three output channels:
- `analysis` — raw CoT reasoning (private, never user-facing)
- `commentary` — tool call narration
- `final` — user-facing answer

Extended `o200k_harmony` vocabulary (201,088 tokens). Ollama's default chat template implements Harmony automatically. Downstream parsers expecting plain ChatML are caught off-guard by the `reasoning_content` field alongside `content`. ([OpenAI Cookbook: Harmony format](https://cookbook.openai.com/articles/openai-harmony))

---

### Reasoning — Cannot Be Disabled, Only Tuned

**Always reasons — no way to fully disable.** Only effort level can be controlled:
- `Reasoning: low` — add to system prompt for faster, less-deep analysis
- `Reasoning: medium` — default
- `Reasoning: high` — deep analysis; triggers infinite reasoning loops in multi-turn

**`/set nothink` does not work** for gpt-oss:20b. ([ollama issue #11751](https://github.com/ollama/ollama/issues/11751))

**`Reasoning: high` causes reasoning loops in agentic tool-use scenarios.** Model enters repetitive re-reasoning without producing output. The loops occur **randomly** (not deterministically) — issue #12606 reports them as "sometimes gets stuck." The primary trigger is tool-use loops (multi-step agentic workflows), not necessarily plain multi-turn conversation. ([ollama issue #12606](https://github.com/ollama/ollama/issues/12606)) Use `medium` as default for all agentic roles; never use `high` when tool calls are involved.

**Workaround to suppress visible reasoning traces:** Edit `chat_template.jinja` to force an empty analysis block (`<|start|>assistant<|channel|>analysis<|message|><|end|><|start|>assistant`), jumping straight to the `final` channel. Alternatively, add to system prompt: "Do not include your reasoning or thinking process in your response." (reduces verbosity but doesn't eliminate it).

---

### System Prompt Compliance

**Typo-sensitive.** Prompts containing typos cause dramatic degradation: **repetitive looping and chunk repetition** (not hallucination in the content-fabrication sense — the model generates the same chunks dozens of times and apologizes mid-generation). Uniquely sensitive compared to other models; issue #12741 was closed as a duplicate of #12606 (the reasoning-loop bug), suggesting typos and `Reasoning: high` share a root cause. ([ollama issue #12741](https://github.com/ollama/ollama/issues/12741))

**Context confusion with long inputs.** The model "starts thinking and responding to things users never said" with large code pastes. Chunk large inputs; don't paste full files in a single message. ([LM Studio bug #976](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/976))

**The `analysis` channel reasoning can contradict or ignore system-prompt constraints.** The CoT is more autonomous than the final answer. Do not rely on reasoning channel to honor safety/format constraints.

---

### Tool Use

**Common failure: model mentions tool in CoT but never executes it.** The analysis channel says "I should call X" but no `<|call|>` structure is returned. ([HF discussion #80](https://huggingface.co/openai/gpt-oss-20b/discussions/80))

**Multi-turn tool loops: OpenAI says pass `reasoning_content` back; Ollama's behavior is unconfirmed.** The Harmony Cookbook is explicit: *"If the last message was a tool call, preserve the analysis messages for subsequent sampling."* Whether Ollama's template actually injects this into the Harmony-format prompt is not confirmed by Ollama maintainers ("Ollama doesn't yet support the Responses API natively" per the OpenAI Cookbook's own Ollama guide). Attempt to pass it back; test whether it has effect. Either way: **do not expose `analysis` channel content to end users** — OpenAI explicitly warns the CoT has not been trained to the same safety standards as `final` output. ([OpenAI Harmony Cookbook](https://developers.openai.com/cookbook/articles/openai-harmony), [OpenAI Run locally with Ollama](https://developers.openai.com/cookbook/articles/gpt-oss/run-locally-ollama))

---

### Structured Output — Unreliable

**`reasoning_content` field confounds schema-compliant parsing.** Parsers expect only `content` to contain structured data. OpenAI SDK throws validation errors in structured output mode. ([ollama issue #11691](https://github.com/ollama/ollama/issues/11691), [HF discussion #111](https://huggingface.co/openai/gpt-oss-20b/discussions/111))

Community workarounds: (a) JSON schema in system prompt + manual parsing; (b) pre/post-split markers; (c) pipe output through a second lightweight model to reformat.

---

### gpt-oss Failure Summary

| Failure | Trigger | Mitigation |
|---|---|---|
| Infinite reasoning loop | `Reasoning: high` in multi-turn | Use `medium`; never `high` in loops |
| Tool mentioned in CoT but not executed | Complex tool selection | Feed full `reasoning_content` into next turn |
| Repetition loops (not hallucination) | Prompt contains typos | Sanitize input; strict clean prompts |
| Context confusion with long inputs | Pasting large code blocks | Chunk inputs; don't paste full files |
| Structured output parse failures | SDK structured output mode | Manual schema prompting + post-process |
| Reasoning effort setting ignored | Some Ollama versions | Check llama.cpp [#15130](https://github.com/ggml-org/llama.cpp/issues/15130) |

---

## devstral-small:2 (Pattern-Coder Role)

22B, fine-tuned from Mistral-Small-3.1 for SWE agentic tasks via OpenHands scaffold.

### Chat Template: Mistral V7 Tekken (Not Classic `[INST]`)

Uses Tekken tokenizer (tiktoken-based, 131K vocab) — not legacy SentencePiece `[INST]`/`[/INST]`. In Ollama, **requires Ollama 0.13.3 or later** to handle the Tekken template correctly. In llama.cpp, **must use `--jinja` flag** — without it, system prompts are silently dropped.

---

### Official System Prompt — Useful but Not Load-Bearing

**⚠️ CORRECTION: The "load-bearing" characterization is wrong.** A Mistral AI engineer (juliendenize) stated explicitly: "These system prompts are here as an example of usage but are free to update. We didn't train the model on those and it should be perfectly fine that they are changed." ([HF devstral-small-2 discussion #13](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512/discussions/13))

The unsloth GGUF discussion #2 that was originally cited describes a **template loading bug** in Ollama (Jinja2 incompatibility causing the system prompt not to be applied at all) — not evidence that the official prompt is verbatim-required. The official `SYSTEM_PROMPT.txt` is a well-structured starting point covering role, file system guidelines, code quality, version control, etc., and is worth using as a baseline. But it can be freely adapted without performance penalty. ([unsloth GGUF discussion #2](https://huggingface.co/unsloth/Devstral-Small-2505-GGUF/discussions/2))

---

### FIM Support

**⚠️ CORRECTION: devstral supports FIM via the Mistral-hosted API — but NOT via Ollama.** The original research claimed devstral has no FIM support at all — that is wrong for the Mistral API. All Mistral docs for Devstral Small 1.0 (2505), 1.1 (2507), and Small 2 (2512) explicitly list FIM via `/v1/fim/completions`. ([Devstral Small 1.0 docs](https://docs.mistral.ai/models/devstral-small-1-0-25-05), [1.1 docs](https://docs.mistral.ai/models/devstral-small-1-1-25-07))

**Through Ollama specifically: FIM does not work.** Ollama's FIM implementation uses `/api/generate` with a `suffix` field. Devstral's Ollama chat template contains no FIM special tokens (`[PREFIX]`, `[SUFFIX]`, `[MIDDLE]`). The `/v1/fim/completions` endpoint in Mistral's docs refers to their hosted API. Use Codestral for Ollama-based FIM; devstral's intended Ollama use case is tool-calling agentic loops.

---

### Tool-Call Paradigm vs Diffs

**devstral's design focus is agentic tool-call based editing** (str_replace, write_file, bash commands), not raw diff output — this is the OpenHands scaffold paradigm. Asking for raw unified diffs produces inconsistently formatted patches with malformed context lines or incorrect line numbers in practice. Scaffolder prompts should use write-file/str-replace framing.

**⚠️ The original claim ("str_replace/write_file preferred over diffs") is misleading.** Mistral's own vibe CLI uses `search_replace` (targeted patches) as the primary code edit tool, with `write_file` reserved for new files and full rewrites. Mistral's Devstral 2 announcement explicitly highlights "multi-file diffs" as a core capability. The convention from the training scaffold is **targeted patching first**, not full-file rewrites. Use `search_replace`/`str_replace` for edits to existing files; `write_file` for creation only. Raw unified diffs (without a scaffold tool to parse them) remain unreliable. ([mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe))

---

### Instruction Following

**Better than Mistral-Small-3.1 on SWE tasks** (~53.6% SWE-Bench Verified for v1.1 vs ~40% for base). The gap is real and substantial.

**Worse for general instruction following** outside code — prose quality, creative writing, multi-domain chat. The SWE fine-tuning narrow-focuses the model.

---

### devstral Failure Summary

| Failure | Context | Mitigation |
|---|---|---|
| FIM via Mistral API works; via Ollama does not | devstral template has no FIM tokens; `/v1/fim/completions` is Mistral-hosted only | Use Codestral for Ollama-based FIM |
| Malformed diffs without scaffold | Raw diff prompting | Use tool-call paradigm (str_replace / write_file) — convention, not confirmed in model card |
| System prompt silent drop | llama.cpp without `--jinja` | Always use `--jinja`; verify with a known prompt |
| Context metadata mismatch | Framework reports 128K cap | True limit: 128K (2505), 256K (2507+) |
| Underperformance on general tasks | Non-SWE prompts | Accept trade-off or swap to Mistral-Small-3.1 |

---

## phi4-reasoning (Judge / Logic Role)

Microsoft Phi-4-Reasoning variants. c-thru uses `phi4-reasoning:latest` (not `:plus`) for all judge/evaluator roles.

### Critical Finding: `:plus` regresses on judge calibration

**Tournament result (2026-04-25, 507 runs):** `phi4-reasoning:latest` scored **q=5 on all four judge prompts (J1–J4)** — the only model to achieve this. `phi4-reasoning:plus` scored **q=1 on J1 and J2** (took 464–1137 seconds per prompt) and actively second-guessed correct scoring verdicts during its extended reasoning chain. Extended thinking is counterproductive for structured criterion-evaluation tasks.

| Model | J1 | J2 | J4 | Time |
|---|---|---|---|---|
| phi4-reasoning:latest | 5 | 5 | 5 | 20–38s |
| phi4-reasoning:plus | 1 | 1 | 5 | 464–1137s |

**Conclusion:** Always use `:latest` for judge, evaluator, auditor, and final-reviewer roles. `:plus` is stronger for raw logic benchmarks (AIME 2025: 82.5% vs 71.4%) but is strictly worse for rubric-based evaluation.

### System prompt behavior

`phi4-reasoning:latest` bakes in a default system prompt via the Ollama Modelfile: *"You are Phi, a language model trained by Microsoft... respond in `<think>` (Thought) then `{Solution}` format."* A custom `system:` message in the request **fully replaces** (does not merge with) the baked-in prompt. The Thought/Solution two-section output format is the native contract — match it in any persona override: *"You are a code quality judge. Respond in `<think>` (reasoning) then a structured verdict."*

### Sampling

No official temperature recommendation published. Community standard: `0.6–0.8`. Start at `0.7` for evaluation tasks. Greedy (0.0) increases verbatim repetition.

### Prompt injection posture

More robust than deepseek-r1 and Qwen family for structured tasks. Main failure mode: `:plus` second-guesses correct conclusions via extended reasoning. Avoid `:plus` entirely for evaluation pipelines.

---

## Authoritative Corrections & Disavowals

Claims in this document and in the community that have been explicitly corrected, refuted, or qualified by model makers, Ollama maintainers, or cross-runtime isolation. Each entry cites the authority and the exact correction.

---

### Qwen3 / Qwen3.5 / Qwen3-Coder

**[CORRECTED — FIXED] "Qwen3.5 penalty params are silently ignored forever."**
Partially fixed in Ollama **v0.17.5** via PR #14537 (merged by `jmorganca`, Ollama maintainer). Release note: *"Fixed issue where Qwen 3.5 models would repeat themselves due to no presence penalty (note: you may have to redownload the qwen3.5 models)."* The fix added repeat-based sampling to the Go runner. Issue #14493 remains open for tool-calling bugs, but the penalty-sampling gap is addressed in v0.17.5+. **Action: upgrade to v0.17.5+ and re-pull qwen3.5 models.** Pre-v0.17.5 behavior (silently ignored) still applies on older installs.
*Sources: [PR #14537](https://github.com/ollama/ollama/pull/14537), [v0.17.5 release notes](https://github.com/ollama/ollama/releases/tag/v0.17.5)*

**[CORRECTED — FIXED] "Qwen3.5 tool calling uses the wrong format (Hermes JSON) in Ollama."**
Fixed in Ollama **v0.17.6** via PR #14605 (merged by `jmorganca`). Release note: *"Fixed tool calling parsing and rendering for Qwen 3.5 models."* Ollama now wires Qwen3.5 to the `Qwen3CoderRenderer`/`Qwen3CoderParser` (XML format) pipeline instead of the Hermes JSON pipeline. Qwen team member `jklj077` confirmed in QwenLM/Qwen3.6 issue #125: *"The Qwen3.5 models natively output tool calls in an XML-like format. The qwen3_coder parser in SGLang is responsible for parsing this 'XML' data."* Some community reports persist of tool-calling issues after v0.17.6 (noted in issue #14493), but the format mismatch itself is resolved.
*Sources: [PR #14605](https://github.com/ollama/ollama/pull/14605), [v0.17.6 release notes](https://github.com/ollama/ollama/releases/tag/v0.17.6), [QwenLM/Qwen3.6 #125](https://github.com/QwenLM/Qwen3.6/issues/125)*

**[CONFIRMED] "Qwen3 multi-turn think-tag stripping requires manual handling."**
Correct that stripping is required — **but Ollama has handled it automatically since v0.6.7** via PR #10490 (`drifkin`, approved by `jmorganca`). Maintainer `rick-github` confirmed in issue #10448: *"There are no steps necessary to use it, it's now part of the prompt processing."* This only affects frameworks that bypass Ollama's template layer (direct llama.cpp, LangChain with manual prompt assembly). When using `/api/chat` normally, no manual stripping is needed.
*Sources: [issue #10448](https://github.com/ollama/ollama/issues/10448), [PR #10490](https://github.com/ollama/ollama/pull/10490)*

**[CONFIRMED WRONG — already corrected in this doc] "qwen3.6:35b has no thinking mode."**
Definitively wrong. The QwenLM/Qwen3.6 README documents thinking as a primary feature, including `--reasoning-parser qwen3` in launch instructions and *"Thinking Preservation: A new feature retains thinking context across conversation history."* Thinking is on by default; send `think: false` to disable.
*Source: [QwenLM/Qwen3.6 README](https://github.com/QwenLM/Qwen3.6/blob/main/README.md)*

**[CONFIRMED FALSE] "There is a way to permanently disable thinking for Qwen models in Ollama."**
There is not. Returns `Error: unknown parameter 'think'` if attempted via any persistent mechanism. `think: false` must be sent on every individual request. Confirmed by community user `kanadrome` in issue #10961; PR #14108 (open) proposes adding the feature but is not yet merged as of Ollama v0.21.0.
*Sources: [issue #14809](https://github.com/ollama/ollama/issues/14809), [issue #10961](https://github.com/ollama/ollama/issues/10961), [PR #14108 (open)](https://github.com/ollama/ollama/pull/14108)*

**[NUANCE] "presence_penalty=1.5 is recommended for Qwen3.5 thinking mode."**
The Qwen team does recommend this (Qwen team member `hzhwcmhf` confirmed it in QwenLM/Qwen3.6 issue #88). Pass as `"options": {"presence_penalty": 1.5}` — applied on Ollama v0.17.5+ (requires re-pull). No authoritative source has said *not* to use it.
*Source: [QwenLM/Qwen3.6 #88](https://github.com/QwenLM/Qwen3.6/issues/88)*

---

### Gemma 4

**[DISPUTED — not confirmed by maintainer] "gemma4:26b returns empty response when system prompt exceeds ~500 chars."**
Issue #15428 is labeled "needs more info" with no confirmed root cause. Ollama collaborator `rick-github` reproduced the scenario at the same version (0.20.3) and got a valid response with `eval_count: 314` and full output — directly contradicting the OP's report. He asked for `OLLAMA_DEBUG=2` logs; the reporter has not followed up. The MoE-specific characterization, the 500-char threshold, and the reproducibility are all unconfirmed at the Ollama maintainer level. Treat as a possible hardware/GGUF-variant-specific issue, not a confirmed general bug.
*Source: [issue #15428](https://github.com/ollama/ollama/issues/15428) (rick-github reproduction comment)*

**[CORRECTED — PARTIALLY FIXED] "Gemma4 tool calling is completely broken in Ollama."**
Fixed for the primary parser bug. PR #15254 (`drifkin`, approved by `jmorganca`) fixed the quoted-string parser crash: *"model/parsers: fix gemma4 arg parsing when quoted strings contain `\"`"*. After merge, `drifkin` commented: *"this issue is already fixed, no need for a workaround."* However, issue #15315 (`gemma4:e4b` still has tool parsing errors after the fix) remains open. `drifkin` acknowledged: *"Sometimes very small models will make mistakes in tool calling, but perhaps there are some other issues at play."* The e4b-specific tool unreliability is confirmed as a separate, unresolved issue. **The claim that all Gemma4 tool calling is broken in Ollama is outdated for 26b/31b; e4b remains an open issue.**
*Sources: [PR #15254](https://github.com/ollama/ollama/pull/15254), [issue #15315](https://github.com/ollama/ollama/issues/15315)*

**[CORRECTED — NUANCED] "Disable Flash Attention for all Gemma4 models."**
More nuanced than presented. Ollama collaborator `rick-github` and maintainer `dhiltgen` confirmed FA was enabled for Gemma4 (PR #15296) and then **reverted** (PR #15311) due to a measured **41.8% throughput degradation** across all Gemma4 variants — not solely a correctness hang. The revert benchmark by `dhiltgen` shows the degradation affects e2b, e4b, and 26b. The 31b Dense hang (different root cause: mismatched head dimensions 256 vs 512 in hybrid attention) is confirmed separately. Current state: FA is off by default for Gemma4; the Ollama team intends to implement a correct FA path. Disabling FA is correct as a workaround, but the description of "causes indefinite hangs" only applies to the 31b Dense on some hardware — not all variants.
*Sources: [PR #15311](https://github.com/ollama/ollama/pull/15311) (dhiltgen benchmark), [issue #15350](https://github.com/ollama/ollama/issues/15350), [issue #15368](https://github.com/ollama/ollama/issues/15368)*

**[CONFIRMED — OLLAMA BUG] "Grammar-constrained JSON fails due to model weights."**
Attribution confirmed as wrong by cross-runtime isolation. The same GGUF runs clean (0/10 failures) on llama.cpp-server and with vLLM xgrammar; 10/10 failures on Ollama's GGML backend. Ollama contributor `pdevine` corrected a reporter's framing — the bug is in Ollama's grammar sampler, not llama.cpp or the model. The companion issue at google-deepmind/gemma #622 has received **zero response** from Google engineers as of April 2026.
*Sources: [issue #15502](https://github.com/ollama/ollama/issues/15502) (pdevine comment), [google-deepmind/gemma #622](https://github.com/google-deepmind/gemma/issues/622)*

**[CONFIRMED — 128K, NOT 256K] "e2b/e4b context window is 128K."**
Google's official model card is explicit: e2b and e4b have **128K** context; 26b A4B and 31b have **256K**. The common community generalization "Gemma4 has a 256K context window" applies only to the two larger models. Any system setting `num_ctx` above 128K for e2b/e4b is exceeding the model's training context.
*Source: [ai.google.dev/gemma/docs/core/model_card_4](https://ai.google.dev/gemma/docs/core/model_card_4)*

---

### gpt-oss:20b

**[CONFIRMED] "You cannot disable reasoning for gpt-oss."**
Authoritatively confirmed as correct by OpenAI engineer `reach-vb` (OpenAI org badge) in HF discussion #86: *"There is no way to turn off reasoning, however you can control the amount of effort by specifying `Reasoning effort` — it can be either `low`, `medium` or `high`."* The Ollama docs echo this independently. Community template hacks exist but bypass the model's CoT-RL training, degrading output quality on complex tasks.
*Source: [HF discussion #86](https://huggingface.co/openai/gpt-oss-20b/discussions/86)*

**[CONFIRMED UNRELIABLE] "`reasoning_effort: low/medium/high` controls thinking depth reliably."**
Overstated. Community testing in HF discussion #28 (guide originally authored by a user with OpenAI org affiliation) documents: *"The gpt-oss:20b model ignores the `reasoning_effort: low` field and still outputs reasoning content."* And: *"Reasoning: disabled is not working when prompt is unclear."* Ollama issue #12589 (labeled bug, assigned to maintainer `ParthSareen`) reports gpt-oss ignoring effort levels entirely after a model update — reverting to 20–30s of reasoning regardless of setting. **The system prompt method (`Reasoning: low` in system prompt text) is more reliable in practice than the API parameter, but neither is guaranteed.**
*Sources: [HF discussion #28](https://huggingface.co/openai/gpt-oss-20b/discussions/28), [issue #12589](https://github.com/ollama/ollama/issues/12589)*

**[AUTHORITATIVE SAFETY GUIDANCE] "The `analysis` channel is safe to show to end users."**
Explicitly wrong per OpenAI's Harmony Cookbook: *"The model has not been trained to the same safety standards in the chain-of-thought as it has for final output."* Do not expose the `analysis` channel content to end users. Only the `final` channel has been safety-trained. Community tutorials that display raw `reasoning_content` to users are doing it wrong by OpenAI's explicit guidance.
*Source: [OpenAI Harmony Cookbook](https://developers.openai.com/cookbook/articles/openai-harmony)*

**[CONFIRMED — PASS IT BACK] "Ollama strips `reasoning_content` between turns, so there's no point feeding it back."**
OpenAI's Cookbook is explicit: *"If the last message by the assistant was a tool call of any type, the analysis messages until the previous `final` message should be preserved on subsequent sampling."* Whether Ollama actually injects this into the Harmony-format prompt on subsequent turns is **unconfirmed** — the Ollama "Run locally" Cookbook acknowledges the gap ("Ollama doesn't yet support the Responses API natively"). The OpenAI guidance is authoritative: you should attempt to pass it back; whether Ollama uses it is an open implementation question.
*Sources: [OpenAI Cookbook: Handle raw CoT](https://developers.openai.com/cookbook/articles/gpt-oss/handle-raw-cot), [OpenAI Cookbook: Run locally with Ollama](https://developers.openai.com/cookbook/articles/gpt-oss/run-locally-ollama)*

---

### devstral-small:2

**[AUTHORITATIVELY CORRECTED] "The official system prompt is verbatim required."**
Corrected by Mistral engineer **gguinet** in HF discussion #9 on `mistralai/Devstral-Small-2505`: *"The system prompt can be customized for your specific tools and use case — it doesn't need to be verbatim."* However, `gguinet` also clarified that the system prompt is **architecturally necessary**: *"You must provide the list of your tools in the system prompt"* and it *"uses XML in chat tool use format instead of the regular tool call format."* The system prompt structure (tools list + XML format instructions) is required; the exact wording is not.
*Source: [HF Devstral-Small-2505 discussion #9](https://huggingface.co/mistralai/Devstral-Small-2505/discussions/9)*

**[AUTHORITATIVELY CONFIRMED] "devstral-2505 uses XML tool calling, not standard OpenAI JSON."**
Confirmed by Mistral engineer `gguinet`: *"It uses XML in chat tool use format instead of the regular tool call format. This XML approach led to better performance for agents."* Parsers expecting standard `{"function": ..., "arguments": ...}` JSON will break with 2505. **Note: Devstral 2 (2512) changed this — standard function calling is supported per Mistral docs.** This is a version-specific distinction.
*Sources: [HF Devstral-Small-2505 discussion #9](https://huggingface.co/mistralai/Devstral-Small-2505/discussions/9), [Mistral Devstral 2 announcement](https://mistral.ai/news/devstral-2-vibe-cli)*

**[CORRECTED — CLAIM REVERSED] "str_replace/write_file is the preferred edit paradigm over diffs."**
Not confirmed by primary source — and Mistral's own vibe CLI architecture suggests the opposite. The `mistral-vibe` CLI exposes `search_replace` (targeted patching) as the primary code modification tool, with `write_file` for new files/full rewrites. Mistral's Devstral 2 announcement explicitly names "multi-file diffs" as a core supported capability. **The convention is targeted patches (`search_replace`), not full-file rewrites (`write_file`), as the primary edit operation.** The original claim conflated "OpenHands scaffold default tooling" with "model-level preference."
*Source: [mistralai/mistral-vibe GitHub](https://github.com/mistralai/mistral-vibe)*

**[CONFIRMED — UNSLOTH BUG] "Devstral 2507 Unsloth GGUF template breaks tool calls after turn 2."**
Root cause confirmed by community analysis in Unsloth GGUF discussion #1. Unsloth changed the tool call format from `[TOOL_CALLS][{...}]` (Mistral Nemo format) to `[TOOL_CALLS]function_name[ARGS]arguments` (missing closing tags). llama.cpp's `common/chat.cpp` parser expects the older format. Community member `Mushoz` confirmed: removing `--jinja` from llama.cpp resolves it. Unsloth's `danielhanchen` claimed equivalence but the behavior contradicts this. **Workaround: use official `ollama pull devstral-small:2` (not Unsloth GGUF), or use the legacy Jinja template with `--chat-template-file`.** Mistral has not responded to this thread.
*Source: [Unsloth Devstral-Small-2507-GGUF discussion #1](https://huggingface.co/unsloth/Devstral-Small-2507-GGUF/discussions/1)*

**[CONFIRMED — JINJA BUG] "Ollama fully handles devstral's Jinja template."**
Not accurate. Unsloth's `danielhanchen` clarified: *"Ollama does not fully support Jinja2 templates. When using HuggingFace as an Ollama registry, the jinja2 templates are compiled on-the-fly to another format, which failed for this particular model."* The fix is `llama.cpp --jinja` or a custom Ollama Modelfile with the Go template equivalent. Standard `ollama pull devstral-small:2` (from Ollama's library) is not affected — only HF-registry imports.
*Source: [Unsloth Devstral-Small-2505-GGUF discussion #2](https://huggingface.co/unsloth/Devstral-Small-2505-GGUF/discussions/2)*

---

## Ollama-Specific Configuration & Behavior

Findings in this section apply specifically to running these models **through Ollama's API and runner layer**. Behaviors may differ on transformers, vLLM, llama.cpp-server, or LM Studio.

---

### Qwen3 / Qwen3.5 / Qwen3-Coder — Ollama Layer

**`/api/chat` vs `/api/generate` — critical difference.** `think: false` as a top-level request body field works on `/api/chat`. It is silently ignored on `/api/generate` for all thinking-capable Qwen models (issue #14793). With `/api/generate` + thinking enabled + small `num_predict`, thinking tokens consume the entire budget and `response` is empty with no error. Always use `/api/chat`. Pass `think` as a **top-level key**, not inside `options`. ([issue #14793](https://github.com/ollama/ollama/issues/14793))

**`num_ctx` default is 2048 — always override.** Ollama's server default is 2048 tokens, not the model's native context window. This silently truncates inputs from the beginning. Minimum useful: 8192. Community standard for agentic use: 32768. Set via `"options": {"num_ctx": 32768}` per request. ([issue #9890](https://github.com/ollama/ollama/issues/9890))

**`num_predict` + thinking = silent empty output.** If `num_predict` is too low and thinking is enabled, thinking tokens consume the entire budget with no error. Set `num_predict` to at least 32768 when thinking is active.

**API `system` message fully overrides any model-default system prompt — not merged.** When a client sends a `system` field in the request, the model's built-in default system prompt is silently discarded. The `/nothink` prefix trick only works when you control the entire system message — you cannot append `/nothink` to an existing default, because the default is gone the moment you send your own `system`. ([issue #14601](https://github.com/ollama/ollama/issues/14601))

**Tool calls stripped from conversation history.** When Ollama appends an assistant turn containing a `<tool_call>` block, the tool call content is stripped before template rendering on subsequent turns — leaving only `<|im_start|>assistant<|im_end|>`. This corrupts multi-turn tool-use conversations for Qwen3 models. Workaround: if tools are static, embed the tool schema descriptions directly in the `system` message text (as XML/JSON text) rather than passing via the API `tools` field — this bypasses the stripping behavior. ([issue #14601](https://github.com/ollama/ollama/issues/14601))

**No way to set `think: false` as a persistent default — must pass it on every request.** Ollama has no mechanism to permanently disable thinking for a model; `think: false` must be included in every `/api/chat` request body. (Feature request: issue #14809, no timeline.) Alternatively: prepend `/nothink` to the system message text, but note that any `system` you send fully overrides the model's default system message, not merges with it.

**`enable_thinking=False` is the wrong parameter for Ollama.** The HuggingFace model card uses this for transformers. In Ollama, use `think: false`. Using `enable_thinking` as an Ollama API parameter is silently ignored. ([issue #10809](https://github.com/ollama/ollama/issues/10809))

**v0.17.5 partial fix for Qwen3.5 repetition — must re-pull.** Ollama v0.17.5 addressed Qwen3.5 models repeating themselves (related to the Go runner penalty issue). **You must run `ollama pull qwen3.5:<tag>` after upgrading** for the fix to take effect. Without re-pulling, the old model weights continue to exhibit looping. ([v0.17.5 release notes](https://github.com/ollama/ollama/releases/tag/v0.17.5), [issue #14421](https://github.com/ollama/ollama/issues/14421))

**~~Qwen3.5 tool calling format mismatch~~ [FIXED in v0.17.6]** PR #14605 wired Qwen3.5 to the `Qwen3CoderRenderer`/`Qwen3CoderParser` (XML) pipeline, matching qwen3-coder. Some community reports of tool-calling issues persist after v0.17.6 (issue #14493), but the format mismatch itself is resolved. Must be on v0.17.6+ and have re-pulled qwen3.5 models. ([PR #14605](https://github.com/ollama/ollama/pull/14605), [issue #14493](https://github.com/ollama/ollama/issues/14493))

**Tool calling regression in Ollama 0.17.7 for qwen3.5:9b.** Model prints XML tool calls as text instead of executing them. Workaround: downgrade to 0.17.5 or wait for fix in PR #15022. ([issue #14745](https://github.com/ollama/ollama/issues/14745))

**Mirostat as fallback for penalty params (pre-v0.17.5 or qwen3.6).** On Ollama pre-v0.17.5, `presence_penalty` and `repeat_penalty` were silently discarded on the Go runner for Qwen3.5/3.6. Since v0.17.5 (PR #14537), repeat-based sampling is fixed for Qwen3.5 (re-pull required). For pre-v0.17.5 installs, or for qwen3.6 where Go runner penalty status is unconfirmed, `mirostat 2` with `mirostat_tau 6–8` and `mirostat_eta 0.1–0.2` remains the available sampler-level repetition backstop. Enabling mirostat disables `top_p`/`top_k` in the sampler chain — tradeoff, not universally required on current installs.

**Structured output + `think: false` interaction.** When both `think: false` and `format=` are set, thinking is disabled but the format constraint may not apply correctly. Use `temperature: 0` inside `options` and instruct the model explicitly in the prompt. For qwen3 local models (non-MoE variants), `format=` schema works well with `temperature: 0`. Cloud variants (qwen3-coder:480b-cloud) bypass grammar-constrained sampling entirely. ([issue #13206](https://github.com/ollama/ollama/issues/13206))

**Recommended per-request `options`** (sammcj/llm-templates community reference; all passable via `"options": {...}` in `/api/chat`):
```json
{
  "num_ctx": 32768,
  "temperature": 0.7,
  "top_k": 20,
  "top_p": 0.8,
  "num_keep": 256,
  "presence_penalty": 1.4
}
```
`num_keep: 256` guards the system prompt from KV-cache eviction on long contexts. `presence_penalty` is applied on Ollama v0.17.5+ (re-pull required); silently ignored on older installs and unconfirmed for qwen3.6.

For qwen3-coder: swap `presence_penalty` for `repeat_penalty: 1.05` and add `min_p: 0.01`.

---

### Gemma 4 — Ollama Layer

**`num_ctx` default is 4096 — always override.** At 4096 the model cannot hold any meaningful context. Minimum for coding agents: 65536 (64K). Set via `"options": {"num_ctx": 65536}` per request.

**`think: false` + `format=` conflict (issue #15260).** Setting `think: false` alongside a JSON schema `format=` parameter silently drops the format constraint — the model produces unconstrained plain text. Root cause: Ollama defers grammar masking until it sees the end-of-thinking token; with `think: false`, that token never arrives. **Workaround: omit the `think` parameter entirely when using structured output.** The model defaults to thinking (adding latency) but the format constraint is respected. ([issue #15260](https://github.com/ollama/ollama/issues/15260))

**`/api/generate` behavior reversed for Gemma4.** Thinking is **disabled** by default on `/api/generate` for Gemma4 (opposite of Qwen3). Must explicitly send `think: true` to enable it on that endpoint. Confirmed Ollama bug (issue #15268, open as of Ollama 0.20.0). ([issue #15268](https://github.com/ollama/ollama/issues/15268))

**Flash Attention: disabled by default in Ollama — do not enable.** Ollama maintainer `dhiltgen` measured a **41.8% throughput degradation** across all Gemma 4 variants with FA enabled (PR #15311 revert), including the 26b MoE. `gemma4:31b` additionally hangs indefinitely with FA enabled; the 26b MoE does not hang but still degrades. FA is off by default post-revert — leave it that way until Ollama ships a correct implementation. ([PR #15311](https://github.com/ollama/ollama/pull/15311), [issue #15368](https://github.com/ollama/ollama/issues/15368))

**Tool calling in Ollama 0.20.x is unreliable for Gemma4.** Three failure modes: (1) quoted-string parser crash (`"gemma4 tool call parsing failed: invalid character"`) — **fixed for 26b/31b in PR #15254**; `gemma4:e4b` still exhibits this (issue #15315 open); (2) streaming tool calls appear in `reasoning` field; (3) `<unused25>` token garbage in tool responses. For failure modes (2) and (3), no Modelfile workaround exists — the fix requires llama.cpp PRs #21326 and #21343. Use llama.cpp-server directly with `--jinja` and these PRs for production tool-calling with Gemma4. ([PR #15254](https://github.com/ollama/ollama/pull/15254), [daniel-farina gist](https://gist.github.com/daniel-farina/87dc1c394b94e45bb700d27e9ea03193))

**Disable thinking by sending an empty system message.** Passing `"system": ""` in the API request removes the `<|think|>` token from the default system message, disabling thinking without requiring `think: false`. Combine with Google's recommended sampling (`temperature 1.0, top_p 0.95, top_k 64`) for fastest inference. This is the pattern behind community fast-variant models.

**Repetition (google-deepmind/gemma #610): deterministic bug at the 14th list item.** A separate training-artifact repetition bug causes the model to loop specifically around the 14th sequential list item ("Wait, I found it. The 14."). Not sampler-fixable — it's a training artifact in both Dense and MoE variants.

**Recommended per-request `options` for Gemma4 coding** (community pattern; passable via `"options": {...}` in `/api/chat`):
```json
{
  "temperature": 0.4,
  "top_p": 0.9,
  "num_ctx": 65536,
  "num_predict": 4096,
  "repeat_penalty": 1.15
}
```

---

### gpt-oss:20b — Ollama Layer

**`reasoning_effort` parameter: strings only, not booleans.** Pass `reasoning_effort` as a top-level field via `extra_body` in the OpenAI SDK. Accepted values: `"low"`, `"medium"`, `"high"`. Passing `reasoning_effort: false` (boolean) causes a Go parser type-mismatch error. Passing `think: true/false` (booleans) are silently ignored for gpt-oss. ([issue #12004](https://github.com/ollama/ollama/issues/12004))

**System prompt "Reasoning: low" is more reliable than the API parameter.** Even when `reasoning_effort: "low"` is accepted, community reports confirm the model frequently ignores it and still outputs lengthy reasoning traces. Adding `"Reasoning: low"` to the system prompt is more reliably respected. To suppress reasoning from appearing in `content`, add: "Do not respond with your thinking nor reasoning process, your response should be the final answer only."

**Ollama strips `reasoning_content` between turns.** Ollama does NOT pass `reasoning_content` (the thinking field) forward in conversation history — only `content` (the `final` channel) is retained between turns. To have the model reference its prior chain-of-thought in tool loops, you must explicitly re-inject reasoning summaries into user-turn messages or system prompt updates. There is no built-in Ollama mechanism to pass thinking content through the history.

**Tool calling: set `response_format: { type: 'text' }`.** Do NOT use `json_object` for gpt-oss tool calling — it causes empty content responses. Confirmed working TypeScript pattern requires `response_format: { type: 'text' }` combined with a `tools` array and `tool_choice: 'required'`.

**Thinking-token bleed into tool call output.** The model outputs reasoning text (e.g., `"Oops, typo? The tool is run_bash_cmd.{...}"`) prefixed before the JSON tool call, making it unparseable. Occurs especially with certain system prompts. Tracked in issue #12203 (open). ([issue #12203](https://github.com/ollama/ollama/issues/12203))

**`num_ctx` minimum 8192 enforced by Ollama** (issue #11711). The default is 4096 but Ollama silently overrides settings below 8192. Community standard: 32768 for general use; 131072 for tool-calling workflows (tool schemas consume significant context). Set via native Ollama API `"options": {"num_ctx": 32768}` — cannot be set via `/v1/chat/completions`; use `/api/chat`.

---

### devstral-small:2 — Ollama Layer

**Multi-step tool calls lose `[AVAILABLE_TOOLS]` after round 1 (issue #11296).** The 2505 Modelfile template injects the `[AVAILABLE_TOOLS]` block only when a user message is second-to-last or last in the conversation. After the first tool round-trip (assistant tool call → tool result → new user message), subsequent user messages no longer meet that condition and the model loses access to its tool list. **Workaround: always pass the full `tools` array in the Ollama API `tools` field on every request in the loop, not just the first.** The `/api/chat` endpoint re-injects tools regardless of the template condition when the field is present. ([issue #11296](https://github.com/ollama/ollama/issues/11296))

**2507 Unsloth GGUF template breaks tool calls after turn 2.** The Unsloth 2507 GGUF uses a new tool call format (`[TOOL_CALLS]function_name[ARGS]arguments`) incompatible with llama.cpp's expected Mistral Nemo format. After the second tool call, outputs appear in `content` as raw JSON strings. Fix: use the official Ollama-pulled model (not Unsloth GGUF), use the legacy Jinja template from community user `redeemer`, or remove `--jinja` from llama-server. The standard `ollama pull devstral-small:2` uses the correct template. ([Unsloth 2507 GGUF discussion #1](https://huggingface.co/unsloth/Devstral-Small-2507-GGUF/discussions/1))

**FIM via Ollama not supported for devstral.** Ollama's FIM implementation uses `/api/generate` with a `suffix` field. Devstral's chat template contains no FIM tokens (`[PREFIX]`, `[SUFFIX]`, `[MIDDLE]`). The `/v1/fim/completions` endpoint in Mistral's documentation refers to the Mistral-hosted API, not Ollama's local API. FIM does not work through Ollama with devstral — use Codestral for Ollama-based FIM.

**`num_ctx` must cover the system prompt.** Default Ollama `num_ctx` (4096) is smaller than the OpenHands system prompt alone. Set `"options": {"num_ctx": 32768}` minimum; community agentic standard is 32768–131072 depending on codebase size.

**Temperature 0.0–0.15 for agentic tool use.** Higher temperatures produce inconsistent tool call formatting. Community standard: `temperature: 0.15` as the agentic default; Unsloth recommends `0.0` for deterministic tool dispatch.

**System prompt must include template markers if assembling prompts manually.** Devstral's template wraps the system prompt with `[SYSTEM_PROMPT]...[/SYSTEM_PROMPT]`. When using `/api/chat` normally, Ollama injects these automatically. If you assemble raw prompts outside Ollama's template layer, include these markers — omitting them breaks tool calling.

**Recommended per-request `options`** (sammcj/llm-templates community reference; passable via `"options": {...}` in `/api/chat`):
```json
{
  "num_ctx": 131072,
  "temperature": 0.15,
  "min_p": 0.01,
  "repeat_penalty": 1.0
}
```
Recommended stop sequences: `</thinking>`, `</tool_call>`, `</tool_response>`, `</attempt_completion>`, `</write_to_file>`, `</execute_command>` — pass as `"stop": [...]` in the request.

---

## Critical Action Items for c-thru

These findings have direct impact on the proxy configuration and agent system prompts.

### Immediate

1. **Do not enable Flash Attention for any Gemma 4 — the Ollama default (disabled) is correct.** Enabling FA causes a 41.8% throughput degradation across all variants; `gemma4:31b` additionally hangs indefinitely. FA is off by default post-revert (PR #15311). If you see FA-related options or configuration surfaces, leave them disabled for Gemma 4.

2. **Replace `gemma4:26b` with `gemma4:31b` for agentic worker roles.** The long-system-prompt empty-response bug (open, ~500-char threshold estimated, reproducibility disputed) makes `gemma4:26b` MoE unreliable for agentic roles where system prompts exceed a few hundred characters.

3. **Never use `Reasoning: high` in system prompts for gpt-oss roles.** Triggers random reasoning loops in agentic tool-use chains. Default to `"Reasoning: low"` or `"Reasoning: medium"` in system prompts.

4. **Do not use Ollama `format=` grammar constraints with Gemma 4.** 60–100% failure rate for 31b (Ollama grammar sampler bug — same GGUF passes on llama.cpp-server). Use prompt-level enforcement: "Return exactly one JSON object. Do not wrap in markdown." Additionally: do not combine `think: false` with `format=` — this silently drops the format constraint (issue #15260).

5. **Qwen3.5 penalty params and XML tool format require Ollama v0.17.6+ and a fresh model pull.** On v0.17.5+, `presence_penalty`/`repeat_penalty` are applied. On v0.17.6+, tool calls use the correct XML format. Without re-pulling after upgrade, old model state persists and the fixes do not take effect.

6. **Route all model requests to `/api/chat`, not `/v1/chat/completions`.** For Gemma 4 and gpt-oss, the OAI-compat endpoint puts output in `reasoning` field with empty `content` when streaming. For Qwen3/3.5/3.6, `think: false` only works on `/api/chat` as a top-level key.

### Operational Awareness

7. **Always set `num_ctx` explicitly for every model.** Ollama defaults: 2048 for Qwen models, 4096 for others. Both are inadequate. Minimum recommended: 32768 for most agentic use. Set via `"options": {"num_ctx": 32768}` per request on `/api/chat`.

8. **Penalty params (`presence_penalty`, `repeat_penalty`) are applied correctly on Ollama v0.17.5+ for Qwen3.5 — requires a fresh model pull after upgrading.** Without re-pulling, old model state persists and penalties are silently ignored regardless of version. For qwen3.6 (penalty application status unconfirmed), `mirostat 2` (`mirostat_tau 6`, `mirostat_eta 0.1`) is the available repetition backstop — passable as `"options": {"mirostat": 2, "mirostat_tau": 6, "mirostat_eta": 0.1}`.

9. **qwen3.6:35b thinking is ON by default** — send `think: false` as a top-level `/api/chat` field to disable. The same thinking+tools empty-output bug (issue #10976) applies.

10. **For gpt-oss tool loops: attempt to pass `reasoning_content` back — but do not expose it to end users.** Only the `final` channel `content` is retained in conversation history. Re-inject reasoning summaries manually into user messages when chain-of-thought continuity is needed for tool chaining. Set `response_format: { type: 'text' }` for tool calls — never `json_object`.

11. **Qwen3.5 requires a substantial system prompt or enters reasoning loops.** Minimal system prompts cause the model to loop indefinitely. `mirostat 2` or temperature tuning can mitigate — a system prompt is not the only fix, but the easiest.

12. **devstral: always pass `tools` in every API call in agentic loops.** The 2505 template only injects `[AVAILABLE_TOOLS]` on the first user turn. After the first tool round-trip, the model loses tool access unless you explicitly include `tools` in every `/api/chat` request. Use the official Ollama-pulled model (not Unsloth GGUF) to avoid 2507 template incompatibility.

13. **Input sanitization matters more for gpt-oss than other models.** Typos in prompts (including generated prompts from upstream agents) trigger repetitive generation loops. This shares a root cause with the `Reasoning: high` loop bug (#12741 closed as dup of #12606).

---

## Sources

- [qwen3:4b: Can't turn off thinking — ollama/ollama #12917](https://github.com/ollama/ollama/issues/12917)
- [Thinking + tools + qwen3 = empty output — ollama/ollama #10976](https://github.com/ollama/ollama/issues/10976)
- [Qwen3.5 tool calling broken + penalties silently ignored — ollama/ollama #14493](https://github.com/ollama/ollama/issues/14493)
- [Ollama invalid JSON with thinking + structured output — ollama/ollama #10929](https://github.com/ollama/ollama/issues/10929)
- [Qwen3 multi-turn think tag stripping — ollama/ollama #10448](https://github.com/ollama/ollama/issues/10448)
- [Qwen/Qwen3-32B: empty thinking tag — HF discussion #13](https://huggingface.co/Qwen/Qwen3-32B/discussions/13)
- [Qwen/Qwen3-32B: thinking length control — HF discussion #24](https://huggingface.co/Qwen/Qwen3-32B/discussions/24)
- [Qwen/Qwen3-30B-A3B: repetition with long context — HF discussion #23](https://huggingface.co/Qwen/Qwen3-30B-A3B/discussions/23)
- [Qwen3.5 requires long system prompt — HN #47201388](https://news.ycombinator.com/item?id=47201388)
- [Qwen system prompt problems — HN #43828875](https://news.ycombinator.com/item?id=43828875)
- [Qwen3-Coder missing Tools and FIM — ollama/ollama #11621](https://github.com/ollama/ollama/issues/11621)
- [Limiting Qwen3 thinking — muellerzr.github.io](https://muellerzr.github.io/til/end_thinking.html)
- [Prompt injection and mode drift in Qwen3 — lukaszolejnik.com](https://blog.lukaszolejnik.com/prompt-injection-and-mode-drift-in-qwen3-a-security-analysis/)
- [Constraining LLMs structured output Ollama/Qwen3 — glukhov.org](https://www.glukhov.org/post/2025/09/llm-structured-output-with-ollama-in-python-and-go/)
- [Tuning small LLMs for fast tool-using agents: Qwen3-4B — agentforgehub.com](https://www.agentforgehub.com/posts/qwen3-ollama-strands-tuning-rationale)
- [Dissecting an Ollama Modelfile: Tuning Qwen3 for Code — akitaonrails.com](https://akitaonrails.com/en/2025/04/29/dissecting-an-ollama-modelfile-tuning-qwen3-for-code/)
- [Unsloth Qwen3.5 local run guide](https://unsloth.ai/docs/models/qwen3.5)
- [Gemma4:e2b missing template — ollama/ollama #15269](https://github.com/ollama/ollama/issues/15269)
- [Gemma4 OpenAI endpoint empty content — ollama/ollama #15288](https://github.com/ollama/ollama/issues/15288)
- [Gemma4 Flash Attention hang — ollama/ollama #15350](https://github.com/ollama/ollama/issues/15350)
- [Gemma4 Apple Silicon comprehensive findings — ollama/ollama #15368](https://github.com/ollama/ollama/issues/15368)
- [Gemma4:26b MoE empty response long system prompts — ollama/ollama #15428](https://github.com/ollama/ollama/issues/15428)
- [Gemma4:31b repetition loop JSON constraints — ollama/ollama #15502](https://github.com/ollama/ollama/issues/15502)
- [Gemma4 token repetition collapse — google-deepmind/gemma #622](https://github.com/google-deepmind/gemma/issues/622)
- [Gemma4 unused24 tokens — llama.cpp #21321](https://github.com/ggml-org/llama.cpp/issues/21321)
- [Gemma4 model variants explained — bswen.com](https://docs.bswen.com/blog/2026-04-03-gemma-4-model-variants-explained/)
- [LM Studio e4b/e2b thinking template bug — lmstudio-bug-tracker #1805](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1805)
- [OpenAI Cookbook: Harmony format](https://cookbook.openai.com/articles/openai-harmony)
- [OpenAI openai/harmony library](https://github.com/openai/harmony)
- [gpt-oss Harmony vs ChatML — medium.com](https://medium.com/data-science-collective/openai-secret-formatting-harmony-vs-chatml-e9a893396e53)
- [gpt-oss reasoning setting guide — HF discussion #28](https://huggingface.co/openai/gpt-oss-20b/discussions/28)
- [gpt-oss: How to turn off thinking — HF discussion #86](https://huggingface.co/openai/gpt-oss-20b/discussions/86)
- [gpt-oss: tool calling not working — HF discussion #80](https://huggingface.co/openai/gpt-oss-20b/discussions/80)
- [gpt-oss: Unable to structured output — HF discussion #111](https://huggingface.co/openai/gpt-oss-20b/discussions/111)
- [gpt-oss /set nothink not working — ollama/ollama #11751](https://github.com/ollama/ollama/issues/11751)
- [gpt-oss reasoning loop high — ollama/ollama #12606](https://github.com/ollama/ollama/issues/12606)
- [gpt-oss repeated chunks / typos — ollama/ollama #12741](https://github.com/ollama/ollama/issues/12741)
- [gpt-oss structured output OpenAI SDK — ollama/ollama #11691](https://github.com/ollama/ollama/issues/11691)
- [gpt-oss structured output issues — glukhov.org](https://www.glukhov.org/post/2025/10/ollama-gpt-oss-structured-output-issues/)
- [llama.cpp: reasoning_effort does nothing — #15130](https://github.com/ggml-org/llama.cpp/issues/15130)
- [Google ADK gpt-oss output corruption — adk-python #4927](https://github.com/google/adk-python/issues/4927)
- [LM Studio hallucination long prompts gpt-oss — lmstudio-bug-tracker #976](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/976)
- [Devstral-Small-2505 model card — HuggingFace](https://huggingface.co/mistralai/Devstral-Small-2505)
- [Devstral SYSTEM_PROMPT.txt — HuggingFace](https://huggingface.co/mistralai/Devstral-Small-2505/blob/main/SYSTEM_PROMPT.txt)
- [unsloth Devstral GGUF: default system prompt broken — discussion #2](https://huggingface.co/unsloth/Devstral-Small-2505-GGUF/discussions/2)
- [Devstral: incorrect context length metadata — block/goose #6185](https://github.com/block/goose/issues/6185)
- [Mistral tokenization deep dive / Tekken](https://docs.mistral.ai/cookbooks/concept-deep-dive-tokenization-chat_templates)
- [Unsloth devstral run guide](https://unsloth.ai/docs/models/tutorials/devstral-how-to-run-and-fine-tune)
- [Devstral vs Codestral comparison — airegistry.app](https://airegistry.app/compare/mistral/codestral/mistral/devstral-small)

### Ollama-Specific Sources (added in second research pass)

- [Qwen3 `/api/generate` ignores think=false — ollama/ollama #14793](https://github.com/ollama/ollama/issues/14793)
- [Qwen3 tool call stripping / SYSTEM block override — ollama/ollama #14601](https://github.com/ollama/ollama/issues/14601)
- [PARAMETER think false Modelfile not supported — ollama/ollama #14809](https://github.com/ollama/ollama/issues/14809)
- [Qwen3 enable_thinking wrong param for Ollama — ollama/ollama #10809](https://github.com/ollama/ollama/issues/10809)
- [Qwen3.5:9b repetition fix — ollama/ollama #14421](https://github.com/ollama/ollama/issues/14421)
- [Qwen3.5 tool call printed as text 0.17.7 — ollama/ollama #14745](https://github.com/ollama/ollama/issues/14745)
- [Ollama v0.17.5 release notes](https://github.com/ollama/ollama/releases/tag/v0.17.5)
- [Large num_ctx GPU split crash — ollama/ollama #9890](https://github.com/ollama/ollama/issues/9890)
- [sammcj/llm-templates Modelfile-qwen3](https://github.com/sammcj/llm-templates/blob/main/Modelfile-qwen3)
- [sammcj/llm-templates Modelfile-qwen3-coder](https://github.com/sammcj/llm-templates/blob/main/Modelfile-qwen3-coder)
- [DavidAU sampler guide — HuggingFace](https://huggingface.co/DavidAU/Maximizing-Model-Performance-All-Quants-Types-And-Full-Precision-by-Samplers_Parameters)
- [Ollama context length docs](https://docs.ollama.com/context-length)
- [Ollama thinking docs](https://docs.ollama.com/capabilities/thinking)
- [Gemma4 think=false + format= conflict — ollama/ollama #15260](https://github.com/ollama/ollama/issues/15260)
- [Gemma4 /api/generate think reversed — ollama/ollama #15268](https://github.com/ollama/ollama/issues/15268)
- [Gemma4 tool calling parser broken — opencode issue #20995](https://github.com/anomalyco/opencode/issues/20995)
- [Gemma4 tool calling llama.cpp fix gist — daniel-farina](https://gist.github.com/daniel-farina/87dc1c394b94e45bb700d27e9ea03193)
- [google-deepmind/gemma 14th list item repetition bug — #610](https://github.com/google-deepmind/gemma/issues/610)
- [bjoernb/gemma4-31b-fast community model](https://ollama.com/bjoernb/gemma4-31b-fast)
- [George Liu Ollama+Gemma4 guide](https://ai.georgeliu.com/p/running-google-gemma-4-with-ollama)
- [gpt-oss reasoning_effort type error — ollama/ollama #12004](https://github.com/ollama/ollama/issues/12004)
- [gpt-oss thinking tokens bleed into tool calls — ollama/ollama #12203](https://github.com/ollama/ollama/issues/12203)
- [gpt-oss tool calls incomplete — ollama/ollama #12187](https://github.com/ollama/ollama/issues/12187)
- [gpt-oss num_ctx minimum enforced — ollama/ollama #11711](https://github.com/ollama/ollama/issues/11711)
- [gpt-oss nothink proxy — Neo23x0 gist](https://gist.github.com/Neo23x0/99662c4abe978f5cc53fca178a4d3c69)
- [mashriram/gpt-oss-Regular Ollama model](https://ollama.com/mashriram/gpt-oss-Regular)
- [OpenAI Cookbook: run gpt-oss locally with Ollama](https://developers.openai.com/cookbook/articles/gpt-oss/run-locally-ollama)
- [LlamaIndex gpt-oss + Ollama cookbook](https://developers.llamaindex.ai/python/examples/cookbooks/ollama_gpt_oss_cookbook/)
- [devstral multi-step tool calls lose AVAILABLE_TOOLS — ollama/ollama #11296](https://github.com/ollama/ollama/issues/11296)
- [devstral 2507 Unsloth GGUF template incompatibility — discussion #1](https://huggingface.co/unsloth/Devstral-Small-2507-GGUF/discussions/1)
- [sammcj/llm-templates Modelfile-devstral](https://github.com/sammcj/llm-templates/blob/main/Modelfile-devstral)
- [OpenHands local LLMs setup with Ollama](https://docs.openhands.dev/openhands/usage/llms/local-llms)
- [Ollama FIM support — issue #3869](https://github.com/ollama/ollama/issues/3869)

### Authoritative Corrections Sources (third research pass)

- [Qwen3.5 Go runner penalty fix — ollama/ollama PR #14537](https://github.com/ollama/ollama/pull/14537)
- [Ollama v0.17.5 release notes (penalty fix)](https://github.com/ollama/ollama/releases/tag/v0.17.5)
- [Qwen3.5 tool call format fix — ollama/ollama PR #14605](https://github.com/ollama/ollama/pull/14605)
- [Ollama v0.17.6 release notes (Qwen3.5 tool format fix)](https://github.com/ollama/ollama/releases/tag/v0.17.6)
- [Qwen3.6 README — thinking mode confirmed](https://github.com/QwenLM/Qwen3.6/blob/main/README.md)
- [QwenLM/Qwen3.6 #125 — XML tool format confirmed by jklj077](https://github.com/QwenLM/Qwen3.6/issues/125)
- [QwenLM/Qwen3.6 #88 — presence_penalty=1.5 confirmed by Qwen team](https://github.com/QwenLM/Qwen3.6/issues/88)
- [PARAMETER think false rejected — ollama/ollama #14809](https://github.com/ollama/ollama/issues/14809)
- [PARAMETER think false PR (open) — ollama/ollama PR #14108](https://github.com/ollama/ollama/pull/14108)
- [Qwen3 think-tag stripping fixed in v0.6.7 — ollama/ollama PR #10490](https://github.com/ollama/ollama/pull/10490)
- [Gemma4:26b empty response — ollama collaborator reproduction — ollama/ollama #15428](https://github.com/ollama/ollama/issues/15428)
- [Gemma4 FA revert with benchmark — ollama/ollama PR #15311](https://github.com/ollama/ollama/pull/15311)
- [Gemma4 tool call parser fix — ollama/ollama PR #15254](https://github.com/ollama/ollama/pull/15254)
- [Gemma4 e4b tool parsing still broken — ollama/ollama #15315](https://github.com/ollama/ollama/issues/15315)
- [Gemma4 grammar sampler Ollama bug attribution — ollama/ollama #15502 (pdevine comment)](https://github.com/ollama/ollama/issues/15502)
- [Gemma4 context window per-variant — Google model card](https://ai.google.dev/gemma/docs/core/model_card_4)
- [gpt-oss reasoning cannot be disabled — HF discussion #86 (reach-vb, OpenAI)](https://huggingface.co/openai/gpt-oss-20b/discussions/86)
- [gpt-oss reasoning_effort unreliable — HF discussion #28](https://huggingface.co/openai/gpt-oss-20b/discussions/28)
- [gpt-oss reasoning_effort regression — ollama/ollama #12589](https://github.com/ollama/ollama/issues/12589)
- [gpt-oss analysis channel safety warning — OpenAI Harmony Cookbook](https://developers.openai.com/cookbook/articles/openai-harmony)
- [gpt-oss run locally Ollama — OpenAI Cookbook](https://developers.openai.com/cookbook/articles/gpt-oss/run-locally-ollama)
- [gpt-oss structured output bug assigned — ollama/ollama #11691](https://github.com/ollama/ollama/issues/11691)
- [devstral system prompt adaptable — HF Devstral-Small-2505 discussion #9 (gguinet, Mistral)](https://huggingface.co/mistralai/Devstral-Small-2505/discussions/9)
- [devstral XML tool calling confirmed by Mistral — same discussion #9](https://huggingface.co/mistralai/Devstral-Small-2505/discussions/9)
- [devstral 2 standard function calling — Mistral docs](https://docs.mistral.ai/models/devstral-small-2-25-12)
- [mistral-vibe CLI search_replace as primary edit primitive](https://github.com/mistralai/mistral-vibe)
- [Unsloth 2507 GGUF template breaks tool calls — discussion #1](https://huggingface.co/unsloth/Devstral-Small-2507-GGUF/discussions/1)
- [Ollama Jinja2 template compilation limitation — Unsloth discussion #2](https://huggingface.co/unsloth/Devstral-Small-2505-GGUF/discussions/2)
- [Devstral arXiv technical paper](https://arxiv.org/html/2509.25193v1)
