# GEMINI.md

## Project Overview
**c-thru** is a transparent routing and proxy layer designed to sit between Claude Code and various LLM backends (Ollama, OpenRouter, Bedrock, Vertex, or Anthropic). It allows users to use local or alternative cloud models without changing their Claude Code workflow.

Key features include:
- **Hardware-Aware Routing:** Automatically selects models based on detected system RAM.
- **Connectivity-Aware:** Switches between `connected_model` and `disconnect_model` slots automatically when internet status changes.
- **Agentic Planning System (`/c-thru-plan`):** A wave-based orchestrator that breaks complex tasks into parallelizable work items executed by specialized agents.
- **Ollama Fleet Management:** Automatic model pulling, pre-warming, and VRAM management.

## Core Technologies
- **Bash:** The primary entry point (`tools/c-thru`) and various utility hooks.
- **Node.js:** The proxy layer (`tools/claude-proxy`) and configuration helpers. **Strictly stdlib-only; no external dependencies.**
- **Markdown:** Used for agent definitions (`agents/`) and persistent planning state (`current.md`).

## Architecture & Data Flow
1. **Router (`c-thru`):** A bash script that wraps the `claude` binary. It resolves the model route, sets environment variables (like `ANTHROPIC_BASE_URL`), and spawns the proxy.
2. **Proxy (`claude-proxy`):** A Node.js server that translates the Anthropic Messages API to the target provider's API. It handles model field rewriting and fallback logic.
3. **Model Resolution:** A 4-layer graph:
   `Agent Name` → `Capability Alias` → `Concrete Model (via HW Tier)` → `Final Provider Tag`.
4. **Agentic System:** Uses a "wave" lifecycle where a planner (Cloud LLM) designs the plan, and specialized workers (Local LLMs) execute code, tests, and documentation in parallel waves.

## Key Directories
- `tools/`: Core logic, including the router, proxy, and configuration scripts.
- `config/`: Default model maps and hardware-specific recommendations.
- `agents/`: Markdown-based prompts for the agentic planning system.
- `skills/`: MCP-style tool definitions for extending Claude Code's capabilities.
- `docs/`: In-depth documentation on architecture, hardware profiles, and model mapping.
- `wiki/`: Architectural invariants and design decisions.

## Development Conventions

### General Principles
- **No External Node Dependencies:** `claude-proxy` and all `.js` helpers MUST use Node.js standard library only. Do not add a `package.json` or `node_modules`.
- **Directory Layout:** The `tools/` and `config/` two-directory structure is an invariant. Do not flatten or move them relative to each other.
- **Model Rewriting:** Rewriting logic belongs exclusively in the proxy (`claude-proxy`). Hooks and agents must not modify model fields directly.

### Testing & Validation
- **Contract Integrity:** Run `bash tools/c-thru-contract-check.sh` after modifying any agent (`agents/*.md`) or skill (`skills/*/SKILL.md`).
- **Configuration Validation:** Use `node tools/model-map-validate.js config/model-map.json` to check for schema errors.
- **Behavioral Tests:** Enable with `C_THRU_BEHAVIORAL_TESTS=1` when running Node tests.

### Implementation Standards
- **Surgical Updates:** When modifying agents, ensure the `STATUS` and `CONFIDENCE` blocks follow the §12.1 rubric defined in the project docs.
- **Security:** Never log or commit API keys. The proxy handles credentials via environment variables resolved from `model-map.json`.

## Building and Running
- **Installation:** `./install.sh` (symlinks tools to `~/.claude/tools/`).
- **Runtime Smoke Test:** `~/.claude/tools/c-thru --list`.
- **Execution:** Prepend `c-thru` to your Claude Code commands, e.g., `c-thru /c-thru-plan add a new feature`.
- **Debugging:** Use `CLAUDE_ROUTER_DEBUG=1` or `CLAUDE_PROXY_DEBUG=1` for verbose logs.
