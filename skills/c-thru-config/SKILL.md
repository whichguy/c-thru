---
name: c-thru-config
description: |
  Unified c-thru configuration: diagnose the active setup, resolve what a
  capability alias maps to, switch connectivity modes, remap per-capability
  models, validate the config, or reload the running proxy.
  Subcommands: diag [--verbose] | resolve <cap> | mode [<mode>] | remap <cap> <model> [--tier <tier>] | validate | reload
color: cyan
---

# /c-thru-config — Unified Config & Diagnostics

## Routing

Parse the first word of `$ARGUMENTS` as `SUBCOMMAND`. Route to the matching
section below. If `$ARGUMENTS` is empty or the subcommand is unrecognized,
print the usage block:

```
Usage:
  /c-thru-config diag [--verbose]                     full diagnostics view
  /c-thru-config resolve <capability>                 what does X resolve to right now?
  /c-thru-config mode [<mode>]                        read or set connectivity mode
  /c-thru-config remap <cap> <model> [--tier <tier>]  rebind a capability → model
  /c-thru-config validate                             schema check
  /c-thru-config reload                               SIGHUP the running proxy

Modes: connected | semi-offload | cloud-judge-only | offline
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
**Usage:** `/c-thru-config mode <mode>` — persistently set mode

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
const LLM_MODE_ENUM = new Set(['connected','semi-offload','cloud-judge-only','offline']);
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

### Write — validate `<mode>` is one of the four valid values, then:

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  '{"llm_mode": "<MODE>"}'
```

Substitute `<MODE>` with the actual mode argument. On success, print:
`mode set to <MODE> — run '/c-thru-config reload' to apply to running proxy`

If `model-map-edit` is not found at that path, print:
`c-thru-config: model-map-edit not found — run ./install.sh first`

---

## Subcommand: `remap`

**Usage:** `/c-thru-config remap <capability> <model> [--tier <tier>]`

Rebinds `llm_profiles[<tier>][<capability>]` in the user's overrides.
Default tier is the active hardware tier unless `--tier` is given.

Extract `<CAPABILITY>`, `<MODEL>`, and optionally `--tier <TIER>` from `$ARGUMENTS`.
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
```
remapped <CAPABILITY> → <MODEL>  (tier: <TIER>)
run '/c-thru-config reload' to apply to running proxy
```

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

const { resolveActiveTier, resolveProfileModel, LLM_MODE_ENUM } = require(path.join(CLAUDE_DIR, 'tools', 'model-map-resolve.js'));
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
