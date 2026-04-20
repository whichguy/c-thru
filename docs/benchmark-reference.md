# Benchmark Reference for Plan/Wave Agentic Architecture

**Purpose**: Single source of truth for benchmarks that inform model selection in the plan/wave architecture. Use this to re-evaluate model choices as new releases shift rankings.

**Last updated**: April 19, 2026
**Next scheduled review**: Check monthly; full refresh quarterly

---

## Part 1: How to Use This Document

The architecture has 12 agents across 5 cognitive levels. Each agent has specific benchmark dependencies. This document:

1. Identifies which benchmarks predict which agents' performance
2. Names verified sources for each benchmark (primary, fallback, tertiary)
3. Captures current rankings (April 2026) with clear expiration awareness
4. Provides re-check workflow for when new models ship

When a new model launches (e.g., Qwen3.7, Opus 4.8), follow this document's Part 6 workflow to determine if swaps are justified.

---

## Part 2: The Benchmark-to-Agent Mapping

### Agent → Primary Benchmarks Matrix

| Agent | Cognitive Level | Primary | Secondary | Tertiary |
|---|---|---|---|---|
| planner | 5 (Architectural) | DeepPlanning | GPQA Diamond | IFBench |
| review-plan | 5 (Architectural Judgment) | DeepPlanning | IFBench | GPQA Diamond |
| plan-orchestrator | 2 (Structured Reasoning) | IFEval | TPS-Bench | OrchestrationBench |
| integrator | 2 (Structured + Light Code) | IFEval | BFCL V4 | SWE-bench Verified |
| doc-writer | 1-2 (Pattern + Format) | IFEval | MultiChallenge | — |
| scaffolder | 1 (Mechanical Pattern) | IFEval | SWE-bench Verified | BFCL V4 |
| test-writer | 1-2 (Pattern + Edge Cases) | IFEval | SWE-bench Verified | — |
| reviewer-fix | 3 (Iterative Code Analysis) | BFCL V4 Multi-Turn | MultiChallenge | IFEval |
| implementer | 3 (Deep Code) | SWE-bench Pro | SWE-bench Verified | Terminal-Bench 2 |
| auditor | 4 (Judgment) | Terminal-Bench 2 | τ²-Bench | IFEval |
| security-reviewer | 4 (Domain Judgment) | SecCodeBench | GPQA Diamond | SWE-bench Pro |
| final-reviewer | 4 (Judgment + Long Context) | LongBench v2 | AA-LCR | GPQA Diamond |

### The Core Insight

Three benchmarks carry most of the architectural weight:

1. **IFEval** — 8 of 12 agents depend on it primarily or secondarily. This is the binding benchmark for this architecture because agent prompts are structured, specific, and require precise output format following.

2. **DeepPlanning** — The two highest cognitive load agents (planner, review-plan) depend on this primarily. Replaces generic "reasoning" benchmarks with work that actually mirrors Planner's job.

3. **Terminal-Bench 2** — Two judgment agents (auditor, final-reviewer) depend on this primarily. Best proxy for realistic agentic work with judgment overlay.

If you have time to monitor only three benchmarks, these three cover 10 of 12 agents' primary signal.

---

## Part 3: Benchmark Details, Sources, and Current Rankings

### 3.1 IFEval (Instruction Following Evaluation)

**What it measures**: Ability to follow precise instructions with verifiable outputs (e.g., "respond in exactly 3 bullets", "use the word 'pineapple' exactly twice"). Directly predicts whether agents follow their prompts with discipline.

**Why it matters for this architecture**: Agent prompts are highly structured. A model that partially ignores instructions will silently degrade across every agent invocation. IFEval dominates because all 12 agents receive structured prompts.

**Primary source**: https://llm-stats.com/benchmarks/ifeval

**CRITICAL PAGINATION NOTE**: The default view shows 50 of 63 models. When re-checking, explicitly paginate to page 2 or use the API. Missing the pagination caused a methodological error in prior research.

**Fallback sources**:
- Artificial Analysis Intelligence Index (composite, includes IFEval as component): https://artificialanalysis.ai/leaderboards/models
- Qwen model cards on HuggingFace for newest Qwen variants
- Model-specific pages on Ollama library

**Current Rankings (April 2026, verified)**:

| Rank | Model | IFEval Score | Size | Local? |
|---|---|---|---|---|
| #1 | Qwen3.5-27B dense | 0.950 | 17GB | Yes |
| #4 | Qwen3.5-122B-A10B | 0.934 | 81GB | Yes |
| #9 | Qwen3.5-35B-A3B | 0.919 | 24GB | Yes |
| #10 | Qwen3.5-9B | 0.915 | 6.6GB | Yes |
| — | Kimi K2.5 | 0.898 | Cloud | Cloud |
| — | Claude Opus 4.5 | ~0.91 | Cloud | Cloud |

**Key observation**: Qwen family occupies 6 of top 10 positions. This makes Qwen the correct local foundation regardless of other benchmark strengths.

**Pending**: Qwen3.6:35b benchmark pending — launched April 18, 2026, not yet on llm-stats. Expected 4-6 week lag for independent verification.

**Re-check trigger**: any new Qwen release, any Anthropic/OpenAI release claiming instruction-following improvements.

### 3.2 IFBench (Harder IFEval Variant)

**What it measures**: IFEval's successor with harder constraints. Better discrimination among frontier models.

**Why it matters**: IFEval is nearing saturation for top models (90%+). IFBench separates good from great on the capability tier.

**Primary source**: Qwen3.5 model benchmark page (llm-stats hasn't added IFBench leaderboard yet)

**Fallback sources**:
- Anthropic and OpenAI model cards (they sometimes publish IFBench)
- Papers introducing specific models (lab-reported, treat with skepticism)

**Current Rankings (April 2026)**:

| Model | IFBench Score |
|---|---|
| Qwen3.5-397B | 76.5 |
| GPT-5.2 | 75.4 |
| Gemini 3 Pro | 70.4 |
| Claude 4.5 Opus | 58.0 |

**Notable gap**: Qwen3.5-397B beats Claude 4.5 Opus by 18.5 points on IFBench. This is one of the most striking data points in the research. Suggests Qwen family has genuine strengths on structured work that don't appear in general-purpose benchmarks.

**Re-check trigger**: new frontier model release, Opus successor from Anthropic.

### 3.3 DeepPlanning

**What it measures**: Long-horizon agentic planning with verifiable global constraints. Multi-day travel planning, multi-product shopping. Tests global constrained optimization, not just local reasoning.

**Why it matters**: Closest benchmark to Planner's actual job — taking vague intent, producing plan that satisfies constraints (resources, dependencies, timing) globally.

**Primary source**: https://qwenlm.github.io/Qwen-Agent/en/benchmarks/deepplanning/

**Fallback sources**:
- Paper: arxiv.org/abs/2601.18137
- HuggingFace dataset: huggingface.co/datasets/Qwen/DeepPlanning
- llm-stats.com/benchmarks/deep-planning (currently 0 models evaluated there — not yet populated)

**Current Rankings (April 2026)**:

| Model | DeepPlanning Score |
|---|---|
| GPT-5.2 high | 44.6% |
| Qwen3.5-397B | 34.3% |
| Claude 4.5 Opus | 33.9% |

**Notable**: Qwen3.5-397B beats Claude 4.5 Opus on DeepPlanning, though GPT-5.2 leads meaningfully.

**Key insight for architecture**: All frontier models struggle (top score 44.6%). This justifies the review-plan iteration loop and task-level revision capability — don't expect first-draft plans to be correct.

**Re-check trigger**: benchmark is young (Jan 2026); new models will shift rankings frequently for 6-12 months.

### 3.4 GPQA Diamond (Graduate-Level Reasoning)

**What it measures**: PhD-level science questions requiring deep reasoning.

**Why it matters**: Proxy for Planner's ability to handle domain-specific decomposition requiring deep technical reasoning.

**Primary source**: https://llm-stats.com/benchmarks/gpqa

**Fallback sources**:
- Artificial Analysis (includes in Intelligence Index)
- Model-specific pages on llm-stats

**Current Rankings (April 2026)**:

| Model | GPQA Score |
|---|---|
| Claude Opus 4.7 | ~88% |
| GPT-5.2 | ~88% |
| Qwen3.5-397B | 88.4 |
| Claude 4.5 Opus | 87.0 |

**Saturation warning**: GPQA is approaching saturation. Decreasing discrimination value for top models. Use for sanity check only.

**Re-check trigger**: not urgent — use as one-time validation, not ongoing tracking.

### 3.5 SWE-bench Verified

**What it measures**: Real GitHub issues with tests. Agent must produce patch that makes failing tests pass.

**Why it matters**: Standard benchmark for code implementation capability. Predicts implementer, scaffolder, test-writer quality.

**Primary source**: https://llm-stats.com/benchmarks/swe-bench-verified

**Fallback sources**:
- Official: swebench.com (couldn't fetch directly but authoritative)
- vals.ai/benchmarks/swebench (uses minimal bash-tool-only harness for fair comparison)
- Artificial Analysis for SOTA models

**Current Rankings (April 2026)**:

| Model | SWE-Bench Verified |
|---|---|
| Claude Opus 4.6 | 80.9% |
| GPT-5.2 | 80.0% |
| Qwen3.5-397B | 76.2% |
| Devstral Small 2 | 68% (exceptional for 24B size) |

**Saturation warning**: 80%+ for top models. Limited discrimination. See SWE-bench Pro for better signal.

**Harness sensitivity**: Scores vary 10-15 points depending on agent harness. Your LiteLLM setup is a custom harness; scores in training data won't directly transfer.

**Re-check trigger**: new code-specialized model release (Devstral successor, Qwen-Coder update).

### 3.6 SWE-bench Pro

**What it measures**: Harder SWE-bench variant on private/GPL-copyleft repos. Designed to resist training contamination.

**Why it matters**: More predictive of implementer performance on your actual (non-training-data) codebases. Real gap between models appears here.

**Primary source**: https://labs.scale.com/leaderboard/swe_bench_pro_public

**Fallback sources**:
- Scale SEAL leaderboards
- Paper and methodology documentation

**Current Rankings (April 2026)**:

| Model | SWE-Bench Pro |
|---|---|
| GPT-5 | 23.3% |
| Claude Opus 4.1 | 23.1% |
| Claude Opus 4.1 (private subset) | 17.8% |
| GPT-5 (private subset) | 14.9% |

**Critical interpretation**: Top models score 23% Pro vs 80%+ Verified. The 57-point gap reveals how much of Verified performance is pattern matching on training data.

**Architectural implication**: Plan for implementer to produce imperfect code. Reviewer-fix loop is essential, not optional. Even Opus misses 77% of Pro tasks first-pass.

**Re-check trigger**: any new model claiming significant agentic coding improvements.

### 3.7 BFCL V4 (Berkeley Function Calling Leaderboard)

**What it measures**: Tool/function calling ability. V4 tests single-turn, multi-turn, parallel calls, and abstention (not calling unnecessarily).

**Why it matters**: Directly predicts quality for tool-using agents — reviewer-fix, integrator, auditor, scaffolder.

**Primary source**: https://gorilla.cs.berkeley.edu/leaderboard.html

**Fallback sources**:
- GitHub repo with raw data: ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard
- llm-stats.com/benchmarks/bfcl (only 10 models evaluated currently — limited)

**Current Rankings (April 2026)**:

| Model | BFCL V4 Overall |
|---|---|
| Claude 4.5 Opus | 77.5 |
| Qwen3.5-397B | 72.9 |
| GPT-5.2 | 63.1 |

**Important multi-turn observation**: Models that score 90%+ on single-turn can drop to 60-70% on multi-turn. Multi-turn is where reviewer-fix loops live. Check both dimensions separately.

**Re-check trigger**: BFCL V5 release, new function-calling-focused models.

### 3.8 Terminal-Bench 2

**What it measures**: Realistic terminal work — compiling code, training models, configuring servers, debugging. Agentic end-to-end task completion.

**Why it matters**: Closest to Auditor's work — evaluating whether a wave's terminal-produced artifact meets intent.

**Primary source**: https://www.vals.ai/benchmarks/terminal-bench-2

**Fallback sources**:
- Official benchmark site: tbench.ai
- Leaderboard: tbench.ai (open-source, community-contributed tasks)
- Artificial Analysis has terminal-bench-hard subset: artificialanalysis.ai/evaluations/terminalbench-hard

**Current Rankings (April 2026)**:

| Model | Terminal-Bench 2 |
|---|---|
| Claude Opus 4.7 | 68.54% |
| Gemini 3.1 Pro Preview (02/26) | 67.42% |
| GPT 5.3 Codex | 64.04% |
| Muse Spark | 59.55% |
| Claude Sonnet 4.6 | 59.55% |
| Claude Opus 4.5 (Nonthinking) | 58.43% |
| Claude Opus 4.6 (Thinking) | 58.43% |
| GPT 5.4 | 58.43% |

**Key insight**: Opus 4.7 leads meaningfully. Gap between 4.7 and 4.5/4.6 is ~10 points — non-trivial. If you're using Opus for auditor, 4.7 is notably better than 4.5.

**Re-check trigger**: frequent — Terminal-Bench is actively maintained with new submissions.

### 3.9 τ²-Bench (TAU2-Bench)

**What it measures**: Interactive tool invocation with adversarial users across multiple domains (retail, airline, telecom).

**Why it matters**: Validates multi-turn tool use in realistic agentic scenarios. Secondary signal for reviewer-fix and auditor.

**Primary source**: Qwen3.5 benchmark page (Qwen team maintains comparative data)

**Fallback sources**:
- HAL (Holistic Agent Leaderboard): hal.cs.princeton.edu (third-party, cost-aware)
- Note: HAL flagged that earlier TAU-bench Few Shot agent had data leakage that invalidated some results — they excluded that scaffold from analysis

**Current Rankings (April 2026)**:

| Model | τ²-Bench |
|---|---|
| Claude 4.5 Opus | 91.6 |
| GPT-5.2 | 87.1 |
| Qwen3.5-397B | 86.7 |

**Data quality caveat**: Multiple benchmark variants exist. Scores across sources may differ due to harness and prompt differences. Treat directionally, not as absolute truth.

**Re-check trigger**: HAL benchmark releases with updated methodology.

### 3.10 MultiChallenge (Multi-Turn Conversation)

**What it measures**: Quality of multi-turn dialog. Tests consistency, memory, instruction adherence across conversation.

**Why it matters**: Directly predicts reviewer-fix quality in iteration loops. Secondary for agents in bounded iteration loops.

**Primary source**: Qwen3.5 benchmark page

**Fallback sources**:
- Paper and dataset pages
- Model cards from Anthropic/OpenAI when published

**Current Rankings (April 2026)**:

| Model | MultiChallenge |
|---|---|
| Qwen3.5-397B | 67.6 |
| Claude 4.5 Opus | 54.2 |

**Notable gap**: Qwen3.5-397B beats Opus by 13+ points. Another structured-work benchmark where Qwen family excels.

**Re-check trigger**: new releases; benchmark is relatively stable.

### 3.11 TPS-Bench (Tool Planning & Scheduling)

**What it measures**: Tool selection from repository, subtask decomposition, parallel/serial batching, dependency identification.

**Why it matters**: Direct match to plan-orchestrator's job — turning plans into executable wave batches.

**Primary source**: arxiv.org/html/2511.01527 (paper)

**Fallback sources**:
- GitHub repo: github.com/hanwenxu1/mcp-agent
- Future leaderboard sites as benchmark gains adoption

**Current Rankings (April 2026)**:

| Model | TPS-Bench Completion | Execution Style |
|---|---|---|
| GLM-4.5 | 64.72% | Sequential (slow) |
| GPT-4o | 45.08% | Parallel (fast) |

**Architectural insight**: Sequential vs parallel is a tradeoff space, not a quality axis. Plan-orchestrator's batching logic navigates this. Current models lean too hard toward one extreme; your orchestrator prompt should explicitly frame the tradeoff.

**Re-check trigger**: new TPS-Bench evaluations; benchmark is young.

### 3.12 SecCodeBench (Security Code Review)

**What it measures**: Security vulnerability identification in code. Domain-specific.

**Why it matters**: Primary benchmark for security-reviewer agent.

**Primary source**: Paper and associated dataset

**Fallback sources**:
- Security research publications
- Domain-specific evaluations from security-focused labs

**Current Rankings**: Not systematically tracked in prior research. Flag for future investigation.

**Re-check trigger**: when security-reviewer agent is implemented (Phase 4 of roadmap).

### 3.13 LongBench v2 (Long Context Reasoning)

**What it measures**: Reasoning over long documents (10K-100K tokens).

**Why it matters**: Primary benchmark for final-reviewer which reads full journal + plan state.

**Primary source**: HuggingFace LongBench leaderboard

**Fallback sources**:
- Artificial Analysis AA-LCR (their long context benchmark)
- Individual model documentation for published scores

**Current Rankings**: Not systematically pulled in prior research. Flag for future investigation.

**Re-check trigger**: when final-reviewer implementation begins.

---

## Part 4: Benchmarks to Ignore (and Why)

These benchmarks are often cited but don't meaningfully predict this architecture's agent performance:

**HumanEval**: Saturated (99% for Kimi K2.5). No discrimination value. Function-generation task doesn't match multi-file work.

**AIME / HMMT (Math)**: Work isn't math-heavy. High scores don't translate to agentic coding.

**MMLU (general)**: Too broad. MMLU-Pro more discriminating. Neither primary for this architecture.

**Chatbot Arena / LMArena**: Measures human preference for chat. Minimal correlation with agent task success. Used heavily in marketing; avoid for architecture decisions.

**HellaSwag / WinoGrande**: Older, saturated. Don't predict agent behavior.

**GSM8K**: Grade-school math. Saturated. Not relevant.

---

## Part 5: Source Reliability Hierarchy

Based on comprehensive source research, here's the trustworthiness hierarchy:

### Tier 1: Most Trustworthy
1. **Third-party independent evaluations**: HAL (hal.cs.princeton.edu), vals.ai, Artificial Analysis
2. **Verified leaderboards with published methodology**: Gorilla BFCL, Terminal-Bench
3. **Published benchmarks with open data**: SWE-bench Verified, IFEval

### Tier 2: Moderately Trustworthy
4. **Aggregators pulling from multiple sources**: llm-stats.com
5. **Artificial Analysis Intelligence Index** (composite, transparent methodology)

### Tier 3: Less Trustworthy
6. **Lab-reported scores** (model makers testing their own models — verification bias)
7. **Blog synthesis articles** (often echo-chamber; top-N truncated)
8. **Community reports without methodology details**

### Tier 4: Least Trustworthy — Avoid as Primary
9. **Twitter/Reddit claims without links to methodology**
10. **Marketing materials**

### Three-Source Rule

For any consequential model selection decision, triangulate across at least three sources:
1. llm-stats.com or Artificial Analysis (aggregator)
2. Official model documentation (Ollama page, HuggingFace model card, lab report)
3. Third-party evaluation (HAL, vals.ai, independent analysis)

If sources agree, trust. If disagree substantially (>5 points), investigate before committing.

---

## Part 6: Re-Check Workflow for New Model Releases

When a new model releases that might shift rankings, follow this workflow:

### Step 1: Identify the Claim

What does the release claim to improve? Agentic coding? Instruction following? Long context? Match claim to relevant benchmarks from Part 3.

### Step 2: Find Primary Benchmark Data

For each relevant benchmark:
1. Check primary source (linked in Part 3)
2. Check fallback sources if primary doesn't yet have the model
3. Accept lab-reported scores as directional only until third-party validation appears
4. Expect 2-6 week lag between release and independent benchmark data

### Step 3: Check Against Role Requirements

Match new model to agent roles:
- Does it beat Qwen3.6:35b on IFEval? → Consider for orchestration tier
- Does it beat Devstral on SWE-bench Pro? → Consider for implementer
- Does it beat Opus 4.7 on Terminal-Bench 2 + GPQA? → Consider for judgment tier

### Step 4: Check Availability

- Is it on Ollama? (ollama.com/library/{model})
- What quantizations are available?
- What's the memory footprint?

### Step 5: Four-Test Validation Before Committing

Run these tests in first day of using new model:

1. **IFEval-style structured output**: Run plan-orchestrator on known-good plan. Verify output schema matches. Compare with current model.
2. **Speed verification**: Measure actual tok/s on your hardware. Match against published benchmarks.
3. **Quantization stability**: Run scaffolder/wiring work repeatedly. Look for output inconsistency.
4. **Tool calling reliability**: Run 10 integrator tasks requiring tool use. Measure tool call success rate.

If all four pass: update LiteLLM config. Keep old model as documented fallback for 2-4 weeks.
If any fails: revert LiteLLM config. Agent markdown files don't change either way.

### Step 6: Community Validation Monitoring (2-4 Weeks)

- Watch r/LocalLLaMA for quantization issues
- Check llm-stats.com monthly for updated scores
- Check Ollama pulls as community adoption signal
- If issues emerge, revert and document

---

## Part 7: Current Model Selection Decisions (Snapshot)

### Profile A (128GB Semi-Connected) — Primary Target

| Agent | Model | Rationale |
|---|---|---|
| planner | Opus 4.6/4.7 | DeepPlanning + Terminal-Bench 2 leadership |
| review-plan | Opus 4.6/4.7 | Capability parity with planner |
| plan-orchestrator | Qwen3.6:35b | Intelligence Index 43, 210 tok/s, agentic improvements |
| integrator | Qwen3.6:35b | Shared with orchestrator — structured work |
| doc-writer | Qwen3.6:35b | Shared — Level 1-2 pattern work |
| scaffolder | Qwen3-Coder-30B | Code idioms + IFEval inheritance |
| test-writer | Qwen3-Coder-30B | Shared code specialist |
| reviewer-fix | Qwen3-Coder-30B | Multi-turn code review capability |
| implementer | Devstral Small 2 | SWE-bench 68% at 24B — best-in-class size |
| auditor | Opus 4.6/4.7 | Terminal-Bench 2 leadership + parity |
| security-reviewer | Opus 4.6/4.7 | Domain-critical, no compromise |
| final-reviewer | Opus 4.6/4.7 | Long context + judgment |

**Total local footprint**: 65GB of 110GB usable.
**Expected cost**: $50-200/month API.

### Monitoring Flags

- **Qwen3.6:35b** just launched April 18, 2026. Quantization stability and IFEval still unverified third-party. Fallback to Qwen3.5-35B-A3B if issues emerge.
- **Qwen3-Coder-30B** availability in Ollama library requires verification before committing. If unavailable, substitute Qwen3.5-9B + expanded Devstral role.
- **Opus 4.7** is current SOTA on Terminal-Bench 2 (68.54%). Monitor for Opus 4.8 or equivalent successor.

---

## Part 8: Open Research Gaps

Areas where prior research was incomplete or where newer benchmarks haven't been fully investigated:

1. **SecCodeBench current rankings**: Need systematic data pull when security-reviewer implementation begins.

2. **LongBench v2 current rankings**: Need pull for final-reviewer model confirmation.

3. **Qwen3.6 family benchmarks**: Community data will emerge over 4-6 weeks. Re-verify all ranks then.

4. **OrchestrationBench data**: Newer benchmark from Oct 2025. Rankings not yet widely published.

5. **WildToolBench**: Reveals that no model exceeds 15% on realistic user interaction patterns. Sobering ceiling — should inform system-level expectations but not per-agent selection.

6. **HAL reliability data**: Has insights about "accuracy improving, reliability stagnant" that deserve architectural attention. Revisit for Phase 4-5 implementation.

---

## Part 9: Periodic Review Checklist

### Monthly (30 minutes)
- [ ] Check Ollama library for new model releases
- [ ] Check llm-stats.com for updated IFEval rankings (remember pagination past page 1)
- [ ] Check Artificial Analysis for new entries in Intelligence Index top 20
- [ ] Check Terminal-Bench 2 at vals.ai for new entries

### Quarterly (2 hours)
- [ ] Full refresh of Part 3 rankings for all 13 benchmarks
- [ ] Check HAL reliability dashboard for insights
- [ ] Check Scale SEAL leaderboards for SWE-bench Pro updates
- [ ] Review whether new benchmarks warrant inclusion in this document
- [ ] Update Part 7 with any model swap decisions from the quarter

### On-Demand (when specific event happens)
- [ ] New frontier model release: follow Part 6 workflow
- [ ] Model showing quality issues in production: check if benchmark data predicted it
- [ ] New benchmark paper catching attention: evaluate against architecture needs

---

## Part 10: Key Conclusions to Remember

1. **IFEval is the binding benchmark** for this architecture. 8 of 12 agents depend on it. If a model fails IFEval, it fails for this architecture regardless of other benchmarks.

2. **Qwen family beats Opus on structured work benchmarks** (IFEval, IFBench, MultiChallenge, DeepPlanning, MCP-Mark). Opus wins on agentic execution (BFCL, TAU2, SWE-bench, Terminal-Bench). This maps cleanly to the architecture's work types.

3. **SWE-bench Verified is saturated**; use SWE-bench Pro for honest discrimination.

4. **Top models score 23% on SWE-bench Pro**. Plan for imperfect implementer output; reviewer-fix loop is essential.

5. **Public benchmarks are good for shortlisting, insufficient for final selection**. Run empirical tests on your specific work domain.

6. **Composition exceeds components**. Individual agent benchmark scores don't predict system quality. Measure system outcomes (task completion rate, revision cycles, cost per task), not just agent scores.

7. **LiteLLM config is the right abstraction layer**. Model changes never touch agent definitions. All monitoring recommendations assume this separation.

8. **The three-source rule prevents single-point-of-failure**. Never trust one benchmark source for consequential decisions.

9. **Pagination matters**. Prior research missed 13 of 63 IFEval models by defaulting to page 1. Always verify exhaustive coverage.

10. **Benchmarks age**. A score from 6 months ago may be based on an old harness or outdated scaffold. Re-verify on primary source before acting on historical data.

---

## Revision History

- **April 19, 2026**: Initial consolidation from research sessions
- **Next scheduled**: Monthly check ~May 19, quarterly full refresh ~July 19

---

*Keep this document in sync with architectural decisions. When model mappings in the main architecture spec change, update Part 7 here. When new benchmarks become relevant, add them to Part 3 with full source documentation.*
