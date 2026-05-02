# c-thru

**Transparent, Hardware-Aware LLM Routing for Claude Code.**

`c-thru` is a high-performance proxy and routing layer that sits between Claude Code and your LLM backends. It allows you to leverage local models (via Ollama), alternative cloud providers (OpenRouter, Bedrock, Vertex), and official Anthropic endpoints—all within a single, unmodified Claude Code session.

---

## 🚀 Quick Start

### 1. Install
```bash
git clone https://github.com/whichguy/c-thru.git
cd c-thru
./install.sh
```
*The installer symlinks tools to `~/.claude/tools/` and sets up your default model maps.*

### 2. Configure Backends
Ensure [Ollama](https://ollama.com) is running locally for offline support. For cloud access, set your API keys:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENROUTER_API_KEY="sk-or-..."
```

### 3. Launch
Simply prepend `c-thru` to your usual Claude commands:
```bash
c-thru                 # Standard mode (cloud primary, local fallback)
c-thru --mode offline  # Force all agents to run on local hardware
```

---

## 🧠 What c-thru Accomplishes

Claude Code is a powerful agentic tool, but it is traditionally tied to cloud-hosted Anthropic models. `c-thru` breaks this limitation by providing:

- **Protocol Translation**: Seamlessly converts the Anthropic Messages API to Ollama’s native dialect, preserving tool use, multi-modal inputs, and thinking blocks.
- **Hardware-Aware Routing**: Automatically detects your system RAM and selects models optimized for your hardware (e.g., routing a 35B model on a 128GB Mac vs. an 8B model on a 16GB machine).
- **Hybrid Intelligence**: Allows different "agents" in a single session to run on different models. Your **Planner** can run on Claude 3.5 Sonnet (cloud) while your **Implementer** runs on a local Qwen2.5-Coder (local).
- **Seamless Continuity**: If your internet drops, `c-thru` detects the failure and instantly re-routes requests to local alternatives without crashing your session.

---

## 🛠 How It Works

`c-thru` operates as a two-stage system:

### 1. The Router (`tools/c-thru`)
A lightweight Bash wrapper that intercepts the `claude` execution. It:
- Resolves the current **Hardware Tier** (16GB to 128GB+).
- Checks **Connectivity Status** (Connected vs. Offline).
- Injects a specialized "Agent Fleet" into the session.
- Configures environment variables (like `ANTHROPIC_BASE_URL`) to point to the local proxy.

### 2. The Proxy (`tools/claude-proxy`)
A zero-dependency Node.js server (stdlib only) that manages the actual request flow:
- **Dual-Mode Auth**: Prioritizes client-provided Bearer tokens, falling back to configured x-api-keys for Anthropic.
- **Strategic Cooldowns**: Temporarily routes around failed backends.
- **Network Watcher**: On macOS, it monitors WiFi status via `scutil`. When you reconnect to the internet, it **immediately clears all cooldowns**, making cloud models available again instantly.
- **High Fidelity**: Forwards requests verbatim where possible, ensuring cutting-edge features like "thinking blocks" roundtrip correctly to local models like DeepSeek-R1.

---

## 💡 Key Use Cases

### 📶 Robust Offline Development
Develop and debug code on a plane, in a coffee shop with bad WiFi, or in secure environments. `c-thru --mode offline` ensures your entire agentic workflow remains functional using only your local GPU/CPU.

### 💰 Cost Optimization
Offload token-heavy tasks (like initial codebase indexing or large-scale refactors) to local models while reserving expensive cloud tokens for final reasoning, planning, and architectural judgment.

### 🔒 Enhanced Privacy
Route sensitive internal code to local-only agents (`agentic-coder`, `security-reviewer`) while using cloud models for general queries or public library documentation.

### ⚡ Performance Tuning
Use "Fast" variants of agents (e.g., `fast-coder`, `edge`) that run small, highly-quantized models for trivial transformations, significantly reducing the "waiting for LLM" time in your inner loop.

---

## 📖 Further Reading

- [Connectivity Modes](docs/connectivity-modes.md) — 17 ways to route your traffic.
- [Agent Architecture](docs/agent-architecture.md) — Meet the fleet of 27+ specialized agents.
- [Model Map Reference](docs/model-map.md) — How to customize your routing graph.

---

## License
MIT
