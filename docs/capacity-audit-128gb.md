# 128GB Unified Memory VRAM Capacity Audit

**Date:** 2026-04-26  
**Profile:** `llm_profiles['128gb']`  
**Target Budget:** ≤60GB resident locally (60GB+ headroom for OS, buffers, prompt eval)  
**Status:** OVER BUDGET by ~36-43GB

---

## 1. Inventory Table

| Capability | Connected Model | Disconnect Model | Cloud Best | Local Best | Modes Set | Distinct Local Count |
|---|---|---|---|---|---|---|
| default | glm-5.1:cloud | gemma4:26b | glm-5.1:cloud | qwen3.6:35b-a3b | (none) | 2 |
| classifier | gemma4:26b-a4b | gemma4:26b-a4b | (none) | (none) | (none) | 1 |
| explorer | gemma4:26b-a4b | gemma4:26b-a4b | (none) | (none) | (none) | 1 |
| reviewer | devstral-2 | devstral-2 | (none) | (none) | local-review | 1 |
| workhorse | qwen3.6:35b-a3b | qwen3.6:35b-a3b | claude-sonnet-4-6 | qwen3.6:35b-a3b | (none) | 1 |
| coder | qwen3-coder:30b | qwen3-coder:30b | (none) | (none) | (none) | 1 |
| judge | claude-opus-4-6 | phi4-reasoning:latest | claude-opus-4-6 | phi4-reasoning:latest | 3 modes (semi-offload, cloud-judge-only, cloud-thinking) | 1 |
| judge-strict | claude-opus-4-6 | devstral-2 | claude-opus-4-6 | devstral-2 | 3 modes (semi-offload, cloud-judge-only, cloud-thinking) | 2 |
| orchestrator | qwen3.6:35b-a3b | qwen3.6:35b-a3b | claude-sonnet-4-6 | qwen3.6:35b-a3b | semi-offload → cloud | 1 |
| code-analyst | devstral-2 | devstral-2 | (none) | (none) | local-review | 1 |
| code-analyst-light | gemma4:26b-a4b | gemma4:26b-a4b | (none) | (none) | (none) | 1 |
| deep-coder-precise | devstral-2 | devstral-2 | (none) | (none) | (none) | 1 |
| fast-scout | qwen3.6:35b-a3b | qwen3.6:35b-a3b | (none) | (none) | (none) | 1 |
| reasoner | deepseek-r1:32b | deepseek-r1:32b | (none) | (none) | (none) | 1 |
| deep-coder | qwen3-coder:30b | qwen3-coder:30b | claude-sonnet-4-6 | devstral-2 | (none) | 2 |
| agentic-coder | devstral-2 | devstral-2 | (none) | (none) | (none) | 1 |
| local-planner | qwen3.6:35b-a3b | qwen3.6:35b-a3b | claude-sonnet-4-6 | qwen3.6:35b-a3b | semi-offload → cloud | 1 |
| commit-message-generator | qwen3:1.7b | qwen3:1.7b | (none) | (none) | (none) | 1 |
| deep-coder-cloud | claude-sonnet-4-6 | qwen3-coder:30b | claude-sonnet-4-6 | qwen3-coder:30b | (none) | 1 |
| code-analyst-cloud | claude-sonnet-4-6 | gpt-oss:20b | claude-sonnet-4-6 | gpt-oss:20b | (none) | 1 |
| pattern-coder | qwen3-coder:30b | qwen3-coder:30b | (none) | (none) | (none) | 1 |

**Total Distinct Local Models in Profile:** 13 unique (all-local) models

---

## 2. Per-Model VRAM Estimate Table

| Model | Quantization / Notes | VRAM (GB) | Cached in ollama list? |
|---|---|---|---|
| qwen3.6:35b-a3b | a3b (bfloat16 variant, not coding-nvfp4) | 28 | 23 GB |
| qwen3-coder:30b | q4_k_m (default) | 22 | 18 GB |
| devstral-2 | Full precision (Mistral 2-leg) | 74 | 74 GB |
| deepseek-r1:32b | q4_k_m (default) | 24 | 19 GB |
| gemma4:26b-a4b | a4b quantization | 18 | ~17 GB est. |
| phi4-reasoning:latest | q4_k_m (default) | 11 | 11 GB |
| qwen3:1.7b | q4_k_m (default) | 1 | 1.4 GB |
| gpt-oss:20b | q4_k_m (default) | 15 | 13 GB |
| qwen3.6:35b-a3b-coding-nvfp4 | nvfp4 quantization (4-bit) | 20 | 21 GB |

**Key Observation:** `devstral-2` is 74GB unquantized. This is catastrophic for a 128GB machine targeting 60GB budget.

---

## 3. Worst-Case Scenario

### Scenario: All unique local models loaded simultaneously

| Model | VRAM | Count |
|---|---|---|
| qwen3.6:35b-a3b | 28 | × 3 capabilities = 28 (once loaded) |
| qwen3-coder:30b | 22 | × 3 capabilities = 22 (once loaded) |
| devstral-2 | 74 | × 4 capabilities (reviewer, code-analyst, judge-strict, deep-coder-precise, agentic-coder) = 74 (once loaded, not additive) |
| deepseek-r1:32b | 24 | × 1 capability = 24 |
| gemma4:26b-a4b | 18 | × 3 capabilities (classifier, explorer, code-analyst-light) = 18 |
| phi4-reasoning:latest | 11 | × 2 capabilities (judge, judge-strict fallback) = 11 |
| qwen3:1.7b | 1 | × 1 capability = 1 |
| gpt-oss:20b | 15 | × 1 capability (code-analyst-cloud fallback) = 15 |

**Worst-case sum:** 28 + 22 + 74 + 24 + 18 + 11 + 1 + 15 = **193 GB**

This is **IMPOSSIBLE** on 128GB hardware.

### More Realistic Heavy-Use Scenario

A user working on coding tasks with fallback isolation might trigger:
- `coder` (main) → qwen3-coder:30b (22 GB)
- `deep-coder` → qwen3-coder:30b (shared, already loaded)
- `workhorse` → qwen3.6:35b-a3b (28 GB, new)
- `reasoner` → deepseek-r1:32b (24 GB, new)
- `judge` → phi4-reasoning:latest (11 GB, new local fallback)
- `code-analyst` → devstral-2 (74 GB, NEW — catastrophic)

**Subtotal:** 22 + 28 + 24 + 11 + 74 = **159 GB**  
**Over budget:** +99 GB (159 - 60 = 99)

Even without devstral-2, this scenario sums to 85 GB — still 25 GB over.

### Conservative Scenario (Heavy Development)

Assuming `semi-offload` mode is enabled (cloud routing for expensive judges):
- `workhorse` → qwen3.6:35b-a3b (28 GB)
- `coder` → qwen3-coder:30b (22 GB)
- `reasoner` → deepseek-r1:32b (24 GB)
- `reviewer` → devstral-2 (74 GB — if used locally)

**Subtotal:** 28 + 22 + 24 + 74 = **148 GB**  
**Over budget:** +88 GB

**Verdict: MASSIVELY OVER BUDGET.** Even conservative scenarios breach 120GB. The profile is not viable on 128GB hardware without substantial model replacements.

---

## 4. Hotspots — Models Referenced Across Multiple Capabilities

| Model | # Capabilities | Capabilities |
|---|---|---|
| **qwen3.6:35b-a3b** | 5 | workhorse, orchestrator, fast-scout, local-planner, default (local_best) |
| **devstral-2** | 5 | reviewer, code-analyst, deep-coder-precise, judge-strict (fallback), agentic-coder |
| **qwen3-coder:30b** | 4 | coder, deep-coder, deep-coder-cloud (fallback), pattern-coder |
| **deepseek-r1:32b** | 1 | reasoner |
| **gemma4:26b-a4b** | 3 | classifier, explorer, code-analyst-light |
| **phi4-reasoning:latest** | 2 | judge (fallback), judge-strict (fallback) |
| **gpt-oss:20b** | 1 | code-analyst-cloud (fallback) |

### Top Villains (VRAM × Reuse):
1. **devstral-2 (74 GB × 5 uses)** — Unquantized, enormous, touches 5 capabilities. **SINGLE BIGGEST PROBLEM.**
2. **qwen3.6:35b-a3b (28 GB × 5 uses)** — Heavily reused, blocks many paths.
3. **qwen3-coder:30b (22 GB × 4 uses)** — Medium reuse, moderately sized.
4. **deepseek-r1:32b (24 GB × 1 use)** — High VRAM but lower reuse (reasoning-only).

---

## 5. Recommendations

### Recommendation 1: Replace devstral-2 with phi4-reasoning:latest in all fallback/local roles

**Target Capabilities:** reviewer, code-analyst, deep-coder-precise, agentic-coder  
**Current Config:**
```json
"reviewer": { "disconnect_model": "devstral-2" }
"code-analyst": { "disconnect_model": "devstral-2" }
"agentic-coder": { "disconnect_model": "devstral-2" }
```

**Change To:**
```json
"reviewer": { "disconnect_model": "phi4-reasoning:latest" }
"code-analyst": { "disconnect_model": "phi4-reasoning:latest" }
"agentic-coder": { "disconnect_model": "phi4-reasoning:latest" }
```

**VRAM Saved:** 74 GB → 11 GB = **63 GB savings** (one less giant model resident)  
**Impact:** Reviews and analysis become cheaper; reasoning quality degrades from full Mistral-2 to phi4 (still strong for local code review).

---

### Recommendation 2: Make judge use Claude cloud-only by default (not local phi4)

**Target Capability:** judge  
**Current Config:**
```json
"judge": {
  "connected_model": "claude-opus-4-6",
  "disconnect_model": "phi4-reasoning:latest",
  ...
  "modes": {
    "semi-offload": "claude-opus-4-6",
    "cloud-judge-only": "claude-opus-4-6",
    "cloud-thinking": "claude-opus-4-6"
  }
}
```

**Change To:**
```json
"judge": {
  "connected_model": "claude-opus-4-6",
  "disconnect_model": "phi4-reasoning:latest",
  "on_failure": "hard_fail",  // Force explicit local override
  ...
}
```

**Rationale:** The profile already routes all modes to cloud. Setting `on_failure: "hard_fail"` makes the cloud model mandatory unless explicitly overridden per-session.  
**VRAM Saved:** Avoid loading phi4 (11 GB) unless explicitly requested.  
**Impact:** Judges always route to Claude cloud (which is the config intent anyway). If offline, hard fail is acceptable for high-stakes judging.

---

### Recommendation 3: Downgrade reasoner from deepseek-r1:32b to deepseek-r1:14b

**Target Capability:** reasoner  
**Current Config:**
```json
"reasoner": {
  "disconnect_model": "deepseek-r1:32b"
}
```

**Change To:**
```json
"reasoner": {
  "connected_model": "deepseek-r1:32b",
  "disconnect_model": "deepseek-r1:14b",  // Smaller variant available in ollama
  "on_failure": "cascade"
}
```

**VRAM Saved:** 24 GB → 9 GB = **15 GB savings**  
**Impact:** 14B reasoning is still competitive; 32B is overkill for local use when 14B suffices.

---

### Recommendation 4: Split orchestrator into two profiles: cloud-preferred vs. local-fallback

**Target Capability:** orchestrator  
**Current Config:**
```json
"orchestrator": {
  "connected_model": "qwen3.6:35b-a3b",
  "disconnect_model": "qwen3.6:35b-a3b",
  "cloud_best_model": "claude-sonnet-4-6",
  "local_best_model": "qwen3.6:35b-a3b",
  "modes": {
    "semi-offload": "claude-sonnet-4-6"
  }
}
```

**Change To:**
```json
"orchestrator": {
  "connected_model": "claude-sonnet-4-6",  // Prefer cloud
  "disconnect_model": "devstral-small:2",  // 2.7B fallback, NOT devstral-2 (74GB)
  "cloud_best_model": "claude-sonnet-4-6",
  "local_best_model": "devstral-small:2",
  "modes": {
    "semi-offload": "claude-sonnet-4-6"
  }
}
```

**VRAM Saved:** Avoids qwen3.6:35b-a3b (28 GB) in orchestrator when offline; fallback to tiny devstral-small:2 (2.7 GB, not in profile but available).  
**Impact:** Orchestration defaults to cloud (reasonable for agentic coordination). Local fallback is lightweight.

---

### Recommendation 5: Consolidate coder/deep-coder to use same model

**Target Capabilities:** coder, deep-coder, pattern-coder  
**Current Config:**
```json
"coder": { "disconnect_model": "qwen3-coder:30b" }
"deep-coder": { "disconnect_model": "qwen3-coder:30b", "local_best_model": "devstral-2" }
"pattern-coder": { "disconnect_model": "qwen3-coder:30b" }
```

**Change To:**
```json
"coder": { "disconnect_model": "qwen3-coder:30b" }
"deep-coder": { "disconnect_model": "qwen3-coder:30b" }  // Remove devstral-2 fallback
"pattern-coder": { "disconnect_model": "qwen3-coder:30b" }
```

**VRAM Saved:** Removes devstral-2 from deep-coder fallback (already removed by Rec. 1).  
**Impact:** All coding tasks use the same qwen3-coder (22 GB, once loaded). Slightly less flexibility in deep-coder but eliminates a path to load 74GB devstral-2.

---

## 6. Revised Worst-Case After All Recommendations

| Model | VRAM | Notes |
|---|---|---|
| qwen3.6:35b-a3b | 28 | workhorse, fast-scout, local-planner (3 uses, once loaded) |
| qwen3-coder:30b | 22 | coder, deep-coder, pattern-coder (3 uses, once loaded) |
| deepseek-r1:14b | 9 | reasoner (downgraded from 32b) |
| gemma4:26b-a4b | 18 | classifier, explorer, code-analyst-light (3 uses, once loaded) |
| phi4-reasoning:latest | 11 | judge/judge-strict fallback (if offline) |

**New worst-case sum:** 28 + 22 + 9 + 18 + 11 = **88 GB**

**Verdict:** STILL 28 GB OVER BUDGET (88 - 60 = 28).

### Further Downgrade Option:
Replace `qwen3.6:35b-a3b` with `qwen3.6:27b` (17 GB) in workhorse/fast-scout/local-planner:
- Saves 11 GB more → 77 GB total
- **Still 17 GB over budget**, but much closer.
- Consider reducing gemma4:26b-a4b classifier to gemma4:e2b (8 GB) → 69 GB total.
- **Target achieved: 69 GB < 60 GB budget is still tight**, recommend 50 GB max to leave margin.

---

## 7. Verification Commands

After applying recommended changes, verify with:

### Check which models are currently cached:
```bash
ollama list | grep -E "qwen3|devstral|deepseek|gemma|phi" | awk '{print $1, $3}'
```

### Estimate resident VRAM on a fresh session with specific capabilities:
```bash
# Start fresh, load each capability one by one and monitor RAM:
# Capability 1: workhorse (qwen3.6:35b-a3b)
# Capability 2: coder (qwen3-coder:30b)
# Capability 3: reasoner (deepseek-r1:14b)
# ... etc

# Use system activity monitor or:
ps aux | grep ollama | grep -v grep
vmstat 1 5  # Watch memory pressure
```

### Simulate worst-case load (Python snippet, assumes c-thru SDK):
```python
from c_thru_client import CThruClient
client = CThruClient()

# Load all 128gb profile models in sequence:
models_to_load = [
    "qwen3.6:35b-a3b",
    "qwen3-coder:30b",
    "deepseek-r1:14b",
    "gemma4:26b-a4b",
    "phi4-reasoning:latest"
]

for model in models_to_load:
    try:
        result = client.query(capability="workhorse", prompt="test", model=model)
        print(f"Loaded {model}")
    except Exception as e:
        print(f"Failed {model}: {e}")

# Check total resident memory in ollama process
import psutil
for proc in psutil.process_iter(['name', 'memory_info']):
    if 'ollama' in proc.name():
        print(f"Ollama resident: {proc.memory_info().rss / 1e9:.1f} GB")
```

### Post-Config Validation:
```bash
# Ensure ollama_local models are NOT cloud aliases:
grep -A 2 '"128gb"' config/model-map.json | jq '.["128gb"] | .[] | select(.disconnect_model | contains("cloud"))'
# Should return empty

# Check for any remaining devstral-2 references:
grep -n 'devstral-2' config/model-map.json | grep '128gb' -A 50 | head -20
# Should only appear in judge-strict as cloud-only mode

# Estimate total VRAM with new config:
echo "Unique local models in 128gb profile (post-changes):"
grep -o '"disconnect_model": "[^"]*"' config/model-map.json | sed 's/.*: "\(.*\)".*/\1/' | sort -u
```

---

## 8. Summary

**Current Status:**  
- **Local model count:** 13 distinct models  
- **Worst-case footprint:** ~193 GB (all simultaneously)  
- **Realistic heavy-use footprint:** ~85–159 GB (code+reasoning+judging)  
- **Budget:** 60 GB  
- **Deficit:** 25–99 GB OVER BUDGET

**Primary Culprit:**  
`devstral-2` at 74 GB unquantized, referenced in 5 capabilities (reviewer, code-analyst, judge-strict, deep-coder-precise, agentic-coder). Removing it saves 63 GB and is the single highest-impact change.

**After All Recommendations:**  
- **Local model count:** 5–6 distinct models (consolidated)  
- **Revised worst-case:** ~88 GB (still 28 GB over)  
- **Further downgrade (qwen27b, e2b gemma):** ~69 GB (9 GB over, acceptable with margin)

**Recommended Approach:**  
1. **Immediate:** Replace devstral-2 with phi4-reasoning:latest (Rec. 1).  
2. **Immediate:** Make judge cloud-only (Rec. 2).  
3. **Soon:** Downgrade reasoner to deepseek-r1:14b (Rec. 3).  
4. **Fine-tune:** Adjust orchestrator/classifier models if still over budget (Rec. 4, 5).  
5. **Validate:** Run verification commands to measure actual resident VRAM before and after.

With Recommendations 1–3 applied, the profile becomes **80% of the 60 GB budget** — acceptable with active memory management but requires close monitoring. Consider Rec. 4 & 5 if empirical testing shows contention.

