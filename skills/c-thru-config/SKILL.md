---
name: c-thru-config
description: |
  Unified c-thru configuration: diagnose the active setup, resolve what a
  capability alias maps to, switch connectivity modes, remap per-capability
  models, validate the config, or reload the running proxy.
  Subcommands: diag [--verbose] | resolve <cap> | mode [<mode>] [--reload] | remap <cap> <model> [--tier <tier>] [--reload] | set-cloud-best-model <cap> <model> [--tier <tier>] [--reload] | set-local-best-model <cap> <model> [--tier <tier>] [--reload] | route <model> <backend> [--reload] | backend <name> <url> [--kind <kind>] [--auth-env <VAR>] [--reload] | validate | reload | restart [--force]
color: cyan
---

# /c-thru-config — Unified Config & Diagnostics

## Routing

Parse the first word of `$ARGUMENTS` as `SUBCOMMAND`. Route to the matching
section below. If `$ARGUMENTS` is empty or the subcommand is unrecognized,
print the usage block:

```
Usage:
  /c-thru-config diag [--verbose]                                            full diagnostics view
  /c-thru-config resolve <capability>                                        what does X resolve to right now?
  /c-thru-config mode [<mode>] [--reload]                                    read or set connectivity mode
  /c-thru-config remap <cap> <model> [--tier <tier>] [--reload]              rebind a capability → model
  /c-thru-config set-cloud-best-model <cap> <model> [--tier <tier>] [--reload]  set cloud_best_model for a capability
  /c-thru-config set-local-best-model <cap> <model> [--tier <tier>] [--reload]  set local_best_model for a capability
  /c-thru-config route <model> <backend> [--reload]                          bind a model name → backend
  /c-thru-config backend <name> <url> [--kind <kind>] [--auth-env <VAR>] [--reload]  add/update a backend
  /c-thru-config validate                                                    schema check
  /c-thru-config reload                                                      SIGHUP the running proxy
  /c-thru-config restart [--force]                                           full proxy restart

Modes: connected | semi-offload | cloud-judge-only | offline | cloud-best-quality | local-best-quality
```

---

## Subcommand: `resolve`

**Usage:** `/c-thru-config resolve <capability>`

Answers "under the current mode and hardware tier, what concrete model will
`<capability>` use?" Accepts capability aliases (`deep-coder`) and agent names
(`implementer`).

Extract the capability/agent name from `$ARGUMENTS` (the word after `resolve`).
If missing, print usage and stop.

Run the bash block below, substituting `<CAPABILITY>` with the actual argument
(properly shell-quoted):

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const mapPath = CLAUDE_DIR + '/model-map.json';

let config;
try { config = JSON.parse(fs.readFileSync(mapPath, 'utf8')); }
catch (e) { process.stderr.write('c-thru-config: cannot read ' + mapPath + ': ' + e.message + '\n'); process.exit(1); }

const input = process.argv[1];
if (!input) { process.stderr.write('usage: /c-thru-config resolve <capability>\n'); process.exit(1); }

const {
  resolveLlmMode, resolveActiveTier, resolveCapabilityAlias, resolveProfileModel, LLM_MODE_ENUM,
} = require(path.join(CLAUDE_DIR, 'tools', 'model-map-resolve.js'));

const mode = resolveLlmMode(config);
const tier = resolveActiveTier(config);
const capAlias = resolveCapabilityAlias(input, config, tier);

if (!capAlias) {
  process.stderr.write('c-thru-config: unknown capability or agent: ' + JSON.stringify(input) + '\n');
  process.exit(2);
}

const profile = (config.llm_profiles || {})[tier];
if (!profile) {
  process.stderr.write('c-thru-config: no llm_profiles entry for tier ' + tier + '\n');
  process.exit(1);
}
const aliasKey = capAlias === 'general-default' ? 'default' : capAlias;
const entry = profile[aliasKey];
if (!entry || typeof entry !== 'object') {
  process.stderr.write('c-thru-config: no profile entry for ' + JSON.stringify(capAlias) + ' in tier ' + tier + '\n');
  process.exit(2);
}

const resolved = resolveProfileModel(entry, mode);
if (typeof resolved !== 'string' || !resolved) {
  process.stderr.write('c-thru-config: resolveProfileModel returned empty for ' + JSON.stringify(capAlias) + '\n');
  process.exit(1);
}

const modeSource = process.env.CLAUDE_LLM_MODE ? 'CLAUDE_LLM_MODE env'
  : (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) ? mapPath : 'default';
console.log(resolved);
process.stderr.write('  capability:  ' + capAlias + (input !== capAlias ? '  (via agent: ' + input + ')' : '') + '\n');
process.stderr.write('  mode:        ' + mode + '  (' + modeSource + ')\n');
process.stderr.write('  hw tier:     ' + tier + '\n');
process.stderr.write('  on_failure:  ' + (entry.on_failure || 'cascade') + '\n');
" -- "<CAPABILITY>"
```

Exit codes: 0 on resolved, 2 on unknown capability, 1 on config error.

---

## Subcommand: `mode`

**Usage:** `/c-thru-config mode` — show active mode and its source
**Usage:** `/c-thru-config mode <mode> [--reload]` — persistently set mode; `--reload` sends SIGHUP immediately after

### Read (no second argument in `$ARGUMENTS`):

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
const LLM_MODE_ENUM = new Set(['connected','semi-offload','cloud-judge-only','offline','cloud-best-quality','local-best-quality']);
const envMode = process.env.CLAUDE_LLM_MODE;
if (envMode && LLM_MODE_ENUM.has(envMode)) {
  console.log('mode: ' + envMode + '  (source: CLAUDE_LLM_MODE env — transient, not persisted)');
} else if (overrides.llm_mode && LLM_MODE_ENUM.has(overrides.llm_mode)) {
  console.log('mode: ' + overrides.llm_mode + '  (source: ' + ovrPath + ')');
} else if (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) {
  console.log('mode: ' + config.llm_mode + '  (source: ' + mapPath + ' — system default)');
} else {
  console.log('mode: connected  (source: built-in default)');
}
"
```

### Write — validate `<mode>` is one of the six valid values, then:

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  '{"llm_mode": "<MODE>"}'
```

Substitute `<MODE>` with the actual mode argument. On success, print:
- If `--reload` is absent: `mode set to <MODE> — run '/c-thru-config reload' to apply to running proxy`
- If `--reload` is present: `mode set to <MODE>`

If `--reload` is present in `$ARGUMENTS`, also reload the running proxy immediately after a successful edit:

```bash
~/.claude/tools/c-thru reload || echo "proxy not running — config saved, will apply on next spawn"
```

If `model-map-edit` is not found at that path, print:
`c-thru-config: model-map-edit not found — run ./install.sh first`

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
} else { mode = 'connected'; modeSource = 'built-in default'; }

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
  'judge','judge-strict','orchestrator','local-planner','deep-coder',
  'code-analyst','pattern-coder','commit-message-generator',
  'workhorse','coder','reviewer','explorer','classifier','default',
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
