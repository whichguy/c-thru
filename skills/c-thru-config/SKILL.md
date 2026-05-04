---
name: c-thru-config
description: |
  Unified c-thru configuration: diagnose the active setup, resolve what a
  capability alias maps to, switch connectivity modes, remap per-capability
  models, validate the config, or reload the running proxy.
  Subcommands: diag [--verbose] | resolve <cap> | mode [<mode>] [--reload] | remap <cap> <model> [--tier <tier>] [--reload] | set-cloud-best-model <cap> <model> [--tier <tier>] [--reload] | set-local-best-model <cap> <model> [--tier <tier>] [--reload] | route <model> <backend> [--reload] | backend <name> <url> [--kind <kind>] [--auth-env <VAR>] [--reload] | agent list | agent set <agent> <cap> [--reload] | agent pin <agent> <model> [--reload] | agent reset <agent> [--reload] | validate | reload | restart [--force]
color: cyan
---

# /c-thru-config — Unified Config & Diagnostics

## Routing

Parse the first word of `$ARGUMENTS` as `SUBCOMMAND`. Route to the matching
section below.

### NL fallthrough

If `$ARGUMENTS` is empty or the `SUBCOMMAND` is not a known subcommand, treat
the **full `$ARGUMENTS`** as a natural-language intent. Do NOT print static
usage. Instead, interpret what the user wants and map it to the correct
subcommand below, constructing the arguments as needed. Ask one short
clarifying question only if the intent is genuinely ambiguous.

**Intent mapping table** — map user phrasing to concrete actions:

| User says (examples) | Action | Notes |
|---|---|---|
| "switch to local", "local mode", "best-local-oss", "disconnect", "switch to offline", "go offline", "offline mode" | `mode best-local-oss --reload` | apply immediately |
| "switch to cloud", "cloud mode", "best-cloud", "switch to connected", "go online", "connected mode" | `mode best-cloud --reload` | apply immediately |
| "use best opensource cloud", "best-cloud-oss", "open source cloud", "best open source" | `mode best-cloud-oss --reload` | |
| "what mode am I in", "show mode", "current mode" | `mode` (read) | |
| "use <model> for <cap>", "make <cap> use <model>", "set <cap> to <model>" | `remap <cap> <model>` [--tier] | e.g. "use qwen for coding" → `remap coder qwen3-coder-next:cloud`; default tier is active |
| "set cloud model for <cap> to <model>" | `set-cloud-best-model <cap> <model>` [--tier] | |
| "set local model for <cap> to <model>" | `set-local-best-model <cap> <model>` [--tier] | |
| "route <model> to <backend>", "bind <model> → <backend>" | `route <model> <backend>` | |
| "add backend <name> at <url>", "register backend" | `backend <name> <url>` [--kind] [--auth-env] | |
| "list agents", "show agents", "agent table" | `agent list` | |
| "pin <agent> to <model>", "force <agent> to use <model>" | `agent pin <agent> <model> --reload` | apply immediately |
| "reset <agent>", "restore default for <agent>" | `agent reset <agent> --reload` | apply immediately |
| "move <agent> to <cap>", "set <agent> capability to <cap>" | `agent set <agent> <cap> --reload` | |
| "validate", "check config" | `validate` | |
| "reload", "refresh proxy" | `reload` | |
| "restart proxy", "bounce proxy", "bounce the proxy" | `restart` | |
| "restart proxy force", "force restart" | `restart --force` | |
| "diagnostics", "diag", "what's happening", "status", "show status", "health" | `diag [--verbose]` | |
| "verbose diagnostics", "detailed status" | `diag --verbose` | |
| "what does <cap> resolve to", "what model is <agent>", "what is <cap>" | `resolve <cap_or_agent>` | |
| "disable planner hint", "stop planning hints" | `planning off` | |
| "enable planner hint", "start planning hints" | `planning on` | |
| "toggle planner hint", "flip planner hint" | toggle → planning (infer current state, then enable/disable) | |

**Capability/agent reference table** — when the user mentions a capability or
agent by a natural-language role, resolve to the canonical key:

| User says | Canonical capability/agent |
|---|---|
| "coder", "coding", "code" | `coder` |
| "fallback coder", "backup coder" | `coder-fallback` |
| "planner", "planning", "orchestrator" | `planner` |
| "hard planner", "hardest planning", "complex plan" | `planner-hard` |
| "explorer", "explore", "discovery", "search" | `explore` |
| "tester", "test writer", "tests" | `tester` |
| "docs", "documentation writer" | `docs` |
| "reviewer", "review", "routine review", "code review" | `code-reviewer` |
| "security reviewer", "security review", "sec review" | `reviewer-security` |
| "hypothesis", "debug hypothesis" | `debugger-hypothesis` |
| "investigator", "debug investigate" | `debugger-investigate` |
| "hard debugger", "hard debug", "deep debug" | `debugger-hard` |
| "vision", "image", "screenshot" | `vision` |
| "pdf", "document reading" | `pdf` |
| "generalist", "general purpose" | `generalist` |
| "fast generalist", "fast" | `fast-generalist` |
| "fast scout", "scout", "quick search" | `fast-scout` |
| "long context", "large context" | `long-context` |
| "edge", "small tasks", "minimal" | `edge` |
| "prose writer", "long-form writing" | `writer` |

**Model name shorthand** — when the user mentions a model by a short/partial
name, expand to the full tag registered in `model_routes`:

| User says | Full model tag |
|---|---|
| "qwen coder", "qwen code" | `qwen3-coder-next:cloud` |
| "qwen 35b", "qwen coding" | `qwen3.6:35b-a3b-coding-nvfp4` or `qwen3.6:35b-a3b-coding-mxfp8` (ask if ambiguous) |
| "qwen 27b", "qwen fast" | `qwen3.6:27b-coding-nvfp4` |
| "deepseek r1", "r1" | `deepseek-r1:32b` |
| "deepseek v4", "ds v4" | `deepseek-v4-pro:cloud` |
| "gemma 4", "gemma" | `gemma4:26b` |
| "gemma e2b" | `gemma4:e2b` |
| "sonnet", "claude sonnet" | `claude-sonnet-4-6` |
| "opus", "claude opus" | `claude-opus-4-7` |
| "haiku", "claude haiku" | `claude-haiku-4-5-20251001` |
| "devstral", "devstral small" | `devstral-small-2:24b` |
| "mistral", "mistral small" | `mistral-small3.1:24b` |
| "gpt oss" | `gpt-oss:20b` |

After constructing the subcommand and arguments from the intent table, execute
that subcommand's block exactly as if the user had typed it directly.

---

## Subcommand: `resolve`

**Usage:** `/c-thru-config resolve <capability>`

Answers "under the current mode and hardware tier, what concrete model will
`<capability>` use?" Accepts capability keys (`coder`, `planner`, `code-reviewer`) and agent names.

Extract capability name from `$ARGUMENTS`. If missing, print usage and stop.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(cd "$(dirname "$0")/.." && pwd)")
node "$REPO_ROOT/tools/c-thru-config-helpers.js" resolve "<CAPABILITY>"
```

Exit codes: 0 on resolved, 2 on unknown capability, 1 on config error.

---

## Subcommand: `mode`

**Usage:** `/c-thru-config mode` — show active mode and its source
**Usage:** `/c-thru-config mode <mode> [--reload]` — persistently set mode; `--reload` sends SIGHUP immediately after

### Read (no second argument in `$ARGUMENTS`):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(cd "$(dirname "$0")/.." && pwd)")
node "$REPO_ROOT/tools/c-thru-config-helpers.js" mode-read
```

### Write — validate `<mode>` is one of the five valid values, then:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(cd "$(dirname "$0")/.." && pwd)")
node "$REPO_ROOT/tools/c-thru-config-helpers.js" mode-write "<MODE>" [--reload]
```

If `model-map-edit` is not found (install.sh not run), the helper prints an error and exits 1.

---

## Subcommand: `remap`

**Usage:** `/c-thru-config remap <capability> <model> [--tier <tier>] [--reload]`

Rebinds `llm_profiles[<tier>][<capability>]` in the user's overrides.
Default tier is the active hardware tier unless `--tier` is given.
`--reload` sends SIGHUP to the running proxy immediately after a successful edit.

Extract `<CAPABILITY>`, `<MODEL>`, and optionally `--tier <TIER>` and `--reload` from `$ARGUMENTS`.
If capability or model is missing, print usage and stop.

Steps:
1. Determine tier: use `--tier` value if given, otherwise detect active tier with the
   same logic as `resolve` (env → `llm_active_profile` → `tierForGb(totalmem())`).

2. Read `~/.claude/model-map.json`. Look up the existing entry for
   `llm_profiles[<tier>][<capability>]` to preserve `on_failure`, `modes`, etc.
   If the capability doesn't exist in that tier, confirm with the user before
   creating a new entry.

3. Merge: copy the existing entry (or `{}` if new), then set
   `connected_model = <MODEL>` and `disconnect_model = <MODEL>`.

4. Build the spec and run `model-map-edit`. Use node inline to construct valid JSON
   that preserves any extra fields from the existing entry:

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const mapPath = CLAUDE_DIR + '/model-map.json';
let config = {};
try { config = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch {}
const tier = process.argv[1];
const cap  = process.argv[2];
const model = process.argv[3];
const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
const entry = Object.assign({}, existing, { connected_model: model, disconnect_model: model });
process.stdout.write(JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } }));
" -- "<TIER>" "<CAPABILITY>" "<MODEL>" | xargs -0 -I SPEC \
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  SPEC
```

> **Alternative (simpler):** If you are constructing the spec interactively, build the
> JSON string using node and pass it directly:
>
> ```bash
> CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
> SPEC=$(node -e "
> 'use strict';
> const fs = require('fs'), os = require('os'), path = require('path');
> const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
> const config = JSON.parse(fs.readFileSync(CLAUDE_DIR + '/model-map.json', 'utf8'));
> const tier = process.argv[1], cap = process.argv[2], model = process.argv[3];
> const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
> const entry = Object.assign({}, existing, { connected_model: model, disconnect_model: model });
> process.stdout.write(JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } }));
> " -- "<TIER>" "<CAPABILITY>" "<MODEL>")
> node "$CLAUDE_DIR/tools/model-map-edit" \
>   "$CLAUDE_DIR/model-map.system.json" \
>   "$CLAUDE_DIR/model-map.overrides.json" \
>   "$CLAUDE_DIR/model-map.json" \
>   "$SPEC"
> ```

On success, print:
- If `--reload` is absent:
  ```
  remapped <CAPABILITY> → <MODEL>  (tier: <TIER>)
  run '/c-thru-config reload' to apply to running proxy
  ```
- If `--reload` is present:
  ```
  remapped <CAPABILITY> → <MODEL>  (tier: <TIER>)
  ```

If `--reload` is present, also reload the running proxy immediately after a successful edit:

```bash
~/.claude/tools/c-thru reload || echo "proxy not running — config saved, will apply on next spawn"
```

---

## Subcommand: `set-cloud-best-model`

**Usage:** `/c-thru-config set-cloud-best-model <capability> <model> [--tier <tier>] [--reload]`

Sets `cloud_best_model` on an existing profile entry. Used by `cloud-best-quality` mode when no explicit `modes[cloud-best-quality]` override is present.

Extract `<CAPABILITY>`, `<MODEL>`, and optionally `--tier <TIER>` and `--reload` from `$ARGUMENTS`.

Steps mirror `remap`: detect tier, read existing entry, merge in `cloud_best_model: <MODEL>`, pass to `model-map-edit`.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SPEC=$(node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const config = JSON.parse(fs.readFileSync(CLAUDE_DIR + '/model-map.json', 'utf8'));
const tier = process.argv[1], cap = process.argv[2], model = process.argv[3];
const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
const entry = Object.assign({}, existing, { cloud_best_model: model });
process.stdout.write(JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } }));
" -- "<TIER>" "<CAPABILITY>" "<MODEL>")
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  "$SPEC"
```

On success, print `set cloud_best_model for <CAPABILITY> → <MODEL>  (tier: <TIER>)`.
If `--reload` is present, also run `~/.claude/tools/c-thru reload`.

---

## Subcommand: `set-local-best-model`

**Usage:** `/c-thru-config set-local-best-model <capability> <model> [--tier <tier>] [--reload]`

Sets `local_best_model` on an existing profile entry. Used by `local-best-quality` mode when no explicit `modes[local-best-quality]` override is present.

Same pattern as `set-cloud-best-model`, replacing the merged key:

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SPEC=$(node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const config = JSON.parse(fs.readFileSync(CLAUDE_DIR + '/model-map.json', 'utf8'));
const tier = process.argv[1], cap = process.argv[2], model = process.argv[3];
const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
const entry = Object.assign({}, existing, { local_best_model: model });
process.stdout.write(JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } }));
" -- "<TIER>" "<CAPABILITY>" "<MODEL>")
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  "$SPEC"
```

On success, print `set local_best_model for <CAPABILITY> → <MODEL>  (tier: <TIER>)`.
If `--reload` is present, also run `~/.claude/tools/c-thru reload`.

---

## Subcommand: `route`

**Usage:** `/c-thru-config route <model> <backend> [--reload]`

Binds a specific model name to a named backend in `model_routes`. Any request using that
exact model string will be forwarded to `<backend>` regardless of the route graph.

Extract `<MODEL>`, `<BACKEND>`, and optional `--reload` from `$ARGUMENTS`. Both `<MODEL>` and `<BACKEND>` are required.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SPEC=$(node -e "process.stdout.write(JSON.stringify({model_routes: {[process.argv[1]]: process.argv[2]}}))" -- "<MODEL>" "<BACKEND>")
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  "$SPEC"
```

On success:
- If `--reload` is absent: print `bound <MODEL> → backend '<BACKEND>'` and `run '/c-thru-config reload' to apply to running proxy`
- If `--reload` is present: print `bound <MODEL> → backend '<BACKEND>'` then run:
  ```bash
  ~/.claude/tools/c-thru reload || echo "proxy not running — config saved, will apply on next spawn"
  ```

To remove a binding, delete the key directly from `~/.claude/model-map.overrides.json`
(setting it to an empty string will be rejected by model-map-edit — use `null` in a raw
JSON edit instead).

---

## Subcommand: `backend`

**Usage:** `/c-thru-config backend <name> <url> [--kind <kind>] [--auth-env <VAR>] [--reload]`

Adds or updates a backend entry in `backends`. Default `kind` is `ollama` when omitted.
`--auth-env` sets the env var name that holds the API key (e.g. `OPENROUTER_API_KEY`).

**Note:** this subcommand **replaces** the entire backend entry — it does not merge with
the existing one. If the backend already has fields (e.g. `auth_env`) that you want to
keep, you must re-pass them explicitly, or edit `~/.claude/model-map.overrides.json`
directly.

Extract `<NAME>`, `<URL>`, optional `--kind <KIND>`, optional `--auth-env <VAR>`, and
optional `--reload` from `$ARGUMENTS`. `<NAME>` and `<URL>` are required.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SPEC=$(node -e "
'use strict';
const name = process.argv[1], url = process.argv[2];
const kind = process.argv[3] || 'ollama';
const authEnv = process.argv[4] || null;
const entry = { url, kind };
if (authEnv) entry.auth_env = authEnv;
process.stdout.write(JSON.stringify({ backends: { [name]: entry } }));
" -- "<NAME>" "<URL>" "<KIND_OR_EMPTY>" "<AUTH_ENV_OR_EMPTY>")
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  "$SPEC"
```

Substitute `<KIND_OR_EMPTY>` with the `--kind` value (or empty string to use default `ollama`),
and `<AUTH_ENV_OR_EMPTY>` with the `--auth-env` value (or empty string to omit).

On success:
- If `--reload` is absent: print `backend '<NAME>' set  (url: <URL>, kind: <KIND>)` and `run '/c-thru-config reload' to apply to running proxy`
- If `--reload` is present: print `backend '<NAME>' set  (url: <URL>, kind: <KIND>)` then run:
  ```bash
  ~/.claude/tools/c-thru reload || echo "proxy not running — config saved, will apply on next spawn"
  ```

---

## Subcommand: `restart`

**Usage:** `/c-thru-config restart [--force]`

Performs a full proxy restart: SIGTERM + waits for listener to vanish + re-spawns (port inherited from env or auto-assigned).

```bash
~/.claude/tools/c-thru restart ${FORCE_FLAG}
```

Substitute `${FORCE_FLAG}` with `--force` if present in `$ARGUMENTS`, otherwise leave empty.

---

## Subcommand: `validate`

**Usage:** `/c-thru-config validate`

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node "$CLAUDE_DIR/tools/model-map-validate" "$CLAUDE_DIR/model-map.json" \
  && echo "model-map.json: valid" \
  || echo "model-map.json: INVALID — see errors above"
```

---

## Subcommand: `reload`

**Usage:** `/c-thru-config reload`

Sends SIGHUP to the running proxy so it re-reads the config.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
PID_FILE="$CLAUDE_DIR/proxy.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "reload: no proxy PID file at $PID_FILE — proxy may not be running"
  echo "  the next 'c-thru' invocation will auto-spawn a fresh proxy"
  exit 0
fi

PID=$(cat "$PID_FILE" 2>/dev/null)
if [ -z "$PID" ]; then
  echo "reload: PID file is empty — proxy may not be running"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  if kill -HUP "$PID" 2>/dev/null; then
    echo "reload: sent SIGHUP to proxy (pid $PID)"
  else
    echo "reload: failed to signal pid $PID — try: pkill -HUP -f claude-proxy"
  fi
else
  echo "reload: pid $PID is not running — proxy has stopped"
  echo "  the next 'c-thru' invocation will auto-spawn a fresh proxy"
fi
```

---

## Subcommand: `diag`

**Usage:** `/c-thru-config diag [--verbose]`

Run the following steps in sequence and display the combined output.

### Step 1 — Mode, tier, capability table, and stale-config notice

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const mapPath = CLAUDE_DIR + '/model-map.json';
const ovrPath = CLAUDE_DIR + '/model-map.overrides.json';
let config = {}; try { config = JSON.parse(fs.readFileSync(mapPath,'utf8')); } catch {}
let overrides = {}; try { overrides = JSON.parse(fs.readFileSync(ovrPath,'utf8')); } catch {}

const { resolveActiveTier, resolveLlmMode, resolveProfileModel, LLM_MODE_ENUM } = require(path.join(CLAUDE_DIR, 'tools', 'model-map-resolve.js'));
const envMode = process.env.CLAUDE_LLM_MODE;
let mode, modeSource;
if (envMode && LLM_MODE_ENUM.has(envMode)) {
  mode = envMode; modeSource = 'CLAUDE_LLM_MODE env (transient)';
} else if (overrides.llm_mode && LLM_MODE_ENUM.has(overrides.llm_mode)) {
  mode = overrides.llm_mode; modeSource = ovrPath;
} else if (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) {
  mode = config.llm_mode; modeSource = mapPath + ' (system default)';
} else { mode = 'best-cloud'; modeSource = 'built-in default'; }

const gbOverride = process.env.CLAUDE_LLM_MEMORY_GB;
const gb = gbOverride && parseInt(gbOverride,10) > 0 ? parseInt(gbOverride,10) : Math.ceil(os.totalmem()/(1024**3));
const tier = resolveActiveTier(config);

console.log('mode:     ' + mode + '  (source: ' + modeSource + ')');
console.log('hw tier:  ' + tier + '  (' + gb + ' GB RAM)');

// Stale-config notice: model-map.json written after proxy.pid mtime
try {
  const mapMtime = fs.statSync(mapPath).mtimeMs;
  const pidMtime = fs.statSync(CLAUDE_DIR + '/proxy.pid').mtimeMs;
  if (mapMtime > pidMtime) {
    console.log('\nWARNING: config changed since proxy started — run /c-thru-config reload');
  }
} catch {}

// Capability → model table
const CAPS = [
  'planner','planner-hard','explore','coder','coder-fallback',
  'tester','docs','code-reviewer','reviewer-security',
  'debugger-hypothesis','debugger-investigate','debugger-hard',
  'vision','pdf','writer','edge','generalist','fast-generalist','fast-scout','long-context',
];
const profile = (config.llm_profiles || {})[tier] || {};
const maxLen = CAPS.filter(c => profile[c]).reduce((m,c) => Math.max(m,c.length), 0);
console.log('\nCapability → model  (mode: ' + mode + ', tier: ' + tier + ')');
for (const cap of CAPS) {
  const entry = profile[cap]; if (!entry) continue;
  const resolved = resolveProfileModel(entry, mode);
  const tag = entry.on_failure === 'hard_fail' ? '  [hard_fail]' : '';
  console.log('  ' + cap.padEnd(maxLen + 2) + (resolved || '(unresolved)') + tag);
}
"
```

### Step 2 — Proxy status

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
PID_FILE="$CLAUDE_DIR/proxy.pid"
echo ""
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "proxy:    pid $PID  running"
    # Find the listening port via lsof
    PORT=$(lsof -iTCP -sTCP:LISTEN -n -P -p "$PID" 2>/dev/null | awk 'NR>1{print $9}' | grep -oE '[0-9]+$' | head -1)
    if [ -n "$PORT" ]; then
      PING=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ping" 2>/dev/null || true)
      if [ -n "$PING" ]; then
        echo "          http://127.0.0.1:$PORT  healthy"
      else
        echo "          http://127.0.0.1:$PORT  not responding to /ping"
      fi
    fi
  else
    echo "proxy:    not running  (stale pid file: $PID)"
  fi
else
  echo "proxy:    not running  (no pid file at $PID_FILE)"
fi
```

### Step 3 — Backend health (delegate to c-thru --list)

Only show this step if the `c-thru` tool is available. If `--verbose` was given,
show the full `c-thru --list` output; otherwise show a brief summary.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
echo ""
echo "Backends:"
"$CLAUDE_DIR/tools/c-thru" --list 2>&1 | head -30 || echo "  (c-thru --list unavailable)"
```

### Step 4 — Ollama drift probe (skip if ollama not installed)

Compares the Ollama models referenced by the active tier's profile against those actually
pulled. Prints a one-line summary of any missing models.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
if command -v ollama >/dev/null 2>&1; then
  echo ""
  ollama list 2>/dev/null | node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), readline = require('readline');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const { resolveActiveTier } = require(path.join(CLAUDE_DIR, 'tools', 'model-map-resolve.js'));
let config = {};
try { config = JSON.parse(fs.readFileSync(CLAUDE_DIR + '/model-map.json','utf8')); } catch {}
const tier = resolveActiveTier(config);
const profile = (config.llm_profiles || {})[tier] || {};
const refs = new Set();
for (const e of Object.values(profile)) {
  if (e && typeof e === 'object') {
    [e.connected_model, e.disconnect_model, ...Object.values(e.modes || {})].forEach(m => {
      if (m && m.includes(':') && !m.includes('claude') && !m.includes('gpt')) refs.add(m);
    });
  }
}
const pulled = new Set();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', l => { const t = l.split(/\s+/)[0]; if (t && t !== 'NAME') pulled.add(t); });
rl.on('close', () => {
  const missing = [...refs].filter(m => !pulled.has(m));
  if (missing.length > 0)
    console.log('ollama drift: ' + missing.join(', ') + ' not pulled — run: ollama pull <model>');
  else if (refs.size > 0)
    console.log('ollama: all ' + refs.size + ' capability-referenced model(s) present');
});
  " 2>/dev/null
fi
```

---

## Subcommand: `agent`

**Usage:** `/c-thru-config agent <list|set|pin|reset> [...]`

Override which model an agent uses without editing `config/model-map.json` (system config is read-only). Changes are written to `~/.claude/model-map.overrides.json` and merged at runtime.

Two override modes:
- **Logical remap** (`set`): change which capability tier an agent routes through (e.g. point `coder-fallback` at `planner` instead of `coder`)
- **Direct pin** (`pin`): skip the capability tier entirely and route an agent straight to a specific model tag

### Verb: `list`

```bash
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd 2>/dev/null)" || REPO_ROOT="${CLAUDE_PROFILE_DIR:-$HOME/.claude}/../.."
node "${CLAUDE_PROFILE_DIR:-$HOME/.claude}/tools/c-thru-config-helpers.js" agent-list
```

Prints a three-column table: `AGENT | CAPABILITY | MODEL`. Entries with user overrides are marked with `*`. Pinned entries show `[pinned]` in the capability column.

### Verb: `set`

**Usage:** `/c-thru-config agent set <agent> <capability> [--reload]`

Map `<agent>` → `<capability>` alias (logical tier remap). `<capability>` must be a valid capability key in `llm_profiles[activeTier]` — use `/c-thru-config diag` to list valid values.

Extract `<AGENT>`, `<CAPABILITY>`, and optional `--reload` from `$ARGUMENTS`. Both `<AGENT>` and `<CAPABILITY>` are required.

```bash
AGENT="<AGENT>"
CAPABILITY="<CAPABILITY>"
node "${CLAUDE_PROFILE_DIR:-$HOME/.claude}/tools/c-thru-config-helpers.js" agent-set "$AGENT" "$CAPABILITY" ${RELOAD_FLAG}
```

Substitute `${RELOAD_FLAG}` with `--reload` when present in `$ARGUMENTS`, otherwise empty.

### Verb: `pin`

**Usage:** `/c-thru-config agent pin <agent> <model> [--reload]`

Pin `<agent>` directly to `<model>`, bypassing capability tier lookup. Uses `model:` prefix in `agent_to_capability` internally. The model is resolved through normal `model_routes` for backend lookup.

Extract `<AGENT>`, `<MODEL>`, and optional `--reload` from `$ARGUMENTS`. Both `<AGENT>` and `<MODEL>` are required.

```bash
AGENT="<AGENT>"
MODEL="<MODEL>"
node "${CLAUDE_PROFILE_DIR:-$HOME/.claude}/tools/c-thru-config-helpers.js" agent-pin "$AGENT" "$MODEL" ${RELOAD_FLAG}
```

Substitute `${RELOAD_FLAG}` with `--reload` when present in `$ARGUMENTS`, otherwise empty.

### Verb: `reset`

**Usage:** `/c-thru-config agent reset <agent> [--reload]`

Remove the user override for `<agent>`, restoring the system default. Null-deletes the key from `model-map.overrides.json`. If the agent has no system-default entry, a warning is printed.

Extract `<AGENT>` and optional `--reload` from `$ARGUMENTS`.

```bash
AGENT="<AGENT>"
node "${CLAUDE_PROFILE_DIR:-$HOME/.claude}/tools/c-thru-config-helpers.js" agent-reset "$AGENT" ${RELOAD_FLAG}
```

Substitute `${RELOAD_FLAG}` with `--reload` when present in `$ARGUMENTS`, otherwise empty.

---

## Subcommand: `planning`

**Usage:** `/c-thru-config planning [<anything>]`

Manages the `EnterPlanMode` PreToolUse advisory hook that hints about `/c-thru-plan`
on every Shift+Tab. The hook fires in **all Claude Code sessions** on this machine.

### Intent inference

Parse `$ARGUMENTS` (after stripping the leading `planning` word) as free text.
Infer the user's intent from the meaning of the words — do not require exact keywords.

| Intent signals | Action |
|---|---|
| "off", "disable", "turn off", "remove", "stop", "quiet", "no hint", "opt out", "silence" | → **disable** |
| "on", "enable", "turn on", "add", "register", "activate", "restore" | → **enable** |
| "toggle", "flip", "switch", "invert" | → **invert** (see Action: invert below) |
| "status", "check", "what", "show", "is it", "current", "state" | → **status** |
| empty arguments | → **status** |

If the intent is unclear or contradictory (e.g. "on but maybe off?"), ask the user
one short clarifying question before acting. Do not guess.

---

### Action: status

Report current state — whether the hook is registered and whether the opt-out override is set.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
OVERRIDES="$CLAUDE_DIR/model-map.overrides.json"
HOOK_CMD="$CLAUDE_DIR/tools/c-thru-enter-plan-hook"

hook_registered=no
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  count=$(jq -r --arg cmd "$HOOK_CMD" \
    '(.hooks.PreToolUse // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
    "$SETTINGS" 2>/dev/null || echo 0)
  [ "${count:-0}" -gt 0 ] && hook_registered=yes
fi

hint_pref=unset
if [ -f "$OVERRIDES" ] && command -v jq >/dev/null 2>&1; then
  hint_pref=$(jq -r '.planner_hint // "unset"' "$OVERRIDES" 2>/dev/null || echo unset)
fi

echo "planning hint hook:  $hook_registered"
echo "planner_hint pref:   $hint_pref"
if [ "${CLAUDE_ROUTER_PLANNER_HINT:-1}" = "0" ]; then
  echo "effective:           suppressed  (CLAUDE_ROUTER_PLANNER_HINT=0 env — hook runs but exits silently)"
elif [ "$hook_registered" = "yes" ] && [ "$hint_pref" != "false" ]; then
  echo "effective:           on"
elif [ "$hint_pref" = "false" ]; then
  echo "effective:           off  (opt-out in overrides)"
else
  echo "effective:           off  (hook not registered)"
fi
```

---

### Action: invert

Read current state, then enable if off or disable if on. Single deterministic block — do not split into two steps.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
OVERRIDES="$CLAUDE_DIR/model-map.overrides.json"
HOOK_CMD="$CLAUDE_DIR/tools/c-thru-enter-plan-hook"

if ! command -v jq >/dev/null 2>&1; then
  echo "planning: jq not found" >&2; exit 1
fi

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
[ -f "$OVERRIDES" ] || echo '{}' > "$OVERRIDES"

count=$(jq -r --arg cmd "$HOOK_CMD" \
  '(.hooks.PreToolUse // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
  "$SETTINGS" 2>/dev/null || echo 0)
hint_pref=$(jq -r '.planner_hint // "unset"' "$OVERRIDES" 2>/dev/null || echo unset)

if [ "${count:-0}" -gt 0 ] && [ "$hint_pref" != "false" ]; then
  # currently on → disable
  tmp="${SETTINGS}.tmp.$$"
  jq --arg cmd "$HOOK_CMD" '
    if .hooks.PreToolUse then
      .hooks.PreToolUse |= map(.hooks |= map(select((.command // "") != $cmd)))
      | .hooks.PreToolUse |= map(select(.hooks | length > 0))
    else . end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  tmp="${OVERRIDES}.tmp.$$"
  jq '.planner_hint = false' "$OVERRIDES" > "$tmp" && mv "$tmp" "$OVERRIDES"
  echo "planning hint: toggled off"
  echo "  re-enable: /c-thru-config planning on"
else
  # currently off → enable
  if [ "${count:-0}" -eq 0 ]; then
    tmp="${SETTINGS}.tmp.$$"
    jq --arg cmd "$HOOK_CMD" '
      if .hooks == null then .hooks = {} else . end |
      if .hooks.PreToolUse == null then .hooks.PreToolUse = [] else . end |
      .hooks.PreToolUse += [{"matcher": "EnterPlanMode", "hooks": [{"type": "command", "command": $cmd, "timeout": 3}]}]
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  fi
  tmp="${OVERRIDES}.tmp.$$"
  jq 'del(.planner_hint)' "$OVERRIDES" > "$tmp" && mv "$tmp" "$OVERRIDES"
  echo "planning hint: toggled on"
  echo "  disable: /c-thru-config planning off"
fi
```

---

### Action: disable

Remove the `EnterPlanMode` hook and write `planner_hint: false` to overrides.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
OVERRIDES="$CLAUDE_DIR/model-map.overrides.json"
HOOK_CMD="$CLAUDE_DIR/tools/c-thru-enter-plan-hook"

if ! command -v jq >/dev/null 2>&1; then
  echo "planning: jq not found — cannot modify settings.json" >&2
  exit 1
fi

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
[ -f "$OVERRIDES" ] || echo '{}' > "$OVERRIDES"

tmp="${SETTINGS}.tmp.$$"
jq --arg cmd "$HOOK_CMD" '
  if .hooks.PreToolUse then
    .hooks.PreToolUse |= map(.hooks |= map(select((.command // "") != $cmd)))
    | .hooks.PreToolUse |= map(select(.hooks | length > 0))
  else . end
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

tmp="${OVERRIDES}.tmp.$$"
jq '.planner_hint = false' "$OVERRIDES" > "$tmp" && mv "$tmp" "$OVERRIDES"

echo "planning hint: off"
echo "  hook removed from settings.json, planner_hint: false written to overrides"
echo "  re-enable: /c-thru-config planning on"
```

---

### Action: enable

Register the `EnterPlanMode` hook (idempotent) and clear the opt-out override.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
OVERRIDES="$CLAUDE_DIR/model-map.overrides.json"
HOOK_CMD="$CLAUDE_DIR/tools/c-thru-enter-plan-hook"

if ! command -v jq >/dev/null 2>&1; then
  echo "planning: jq not found — cannot modify settings.json" >&2
  exit 1
fi

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
[ -f "$OVERRIDES" ] || echo '{}' > "$OVERRIDES"

count=$(jq -r --arg cmd "$HOOK_CMD" \
  '(.hooks.PreToolUse // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
  "$SETTINGS" 2>/dev/null || echo 0)

if [ "${count:-0}" -eq 0 ]; then
  tmp="${SETTINGS}.tmp.$$"
  jq --arg cmd "$HOOK_CMD" '
    if .hooks == null then .hooks = {} else . end |
    if .hooks.PreToolUse == null then .hooks.PreToolUse = [] else . end |
    .hooks.PreToolUse += [{"matcher": "EnterPlanMode", "hooks": [{"type": "command", "command": $cmd, "timeout": 3}]}]
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "planning hint: hook registered"
else
  echo "planning hint: hook already registered"
fi

tmp="${OVERRIDES}.tmp.$$"
jq 'del(.planner_hint)' "$OVERRIDES" > "$tmp" && mv "$tmp" "$OVERRIDES"

echo "planning hint: on"
echo "  Note: fires in all Claude Code sessions on this machine"
echo "  Disable: /c-thru-config planning off"
```
