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

Parse `$ARGUMENTS` to route to the matching subcommand below. If no subcommand
is given or it is unrecognized, print the usage block and stop.

```
Usage:
  /c-thru-config diag [--verbose]              # full diagnostics view
  /c-thru-config resolve <capability>          # what does X resolve to right now?
  /c-thru-config mode [<mode>]                 # read or set connectivity mode
  /c-thru-config remap <cap> <model> [--tier <tier>]  # rebind capability → model
  /c-thru-config validate                      # schema check
  /c-thru-config reload                        # SIGHUP the running proxy

Modes: connected | semi-offload | cloud-judge-only | offline
```

---

## Subcommand: `resolve`

**Usage:** `/c-thru-config resolve <capability>`

Answers "under the current mode and hardware tier, what concrete model will
`<capability>` (or agent name) use?" Accepts both capability aliases
(`deep-coder`) and agent names (`implementer`).

```bash
node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const mapPath = path.join(CLAUDE_DIR, 'model-map.json');

let config;
try { config = JSON.parse(fs.readFileSync(mapPath, 'utf8')); }
catch (e) { process.stderr.write('c-thru-config resolve: cannot read ' + mapPath + ': ' + e.message + '\n'); process.exit(1); }

const input = process.argv[1];
if (!input) { process.stderr.write('usage: /c-thru-config resolve <capability>\n'); process.exit(1); }

// ── Mode resolution (mirrors claude-proxy:403 resolveLlmMode) ──
// TODO: dedupe with claude-proxy:403-420 (Phase 2 extraction)
const LLM_MODE_ENUM = new Set(['connected', 'semi-offload', 'cloud-judge-only', 'offline']);
function resolveLlmMode() {
  const e = process.env.CLAUDE_LLM_MODE;
  if (e && LLM_MODE_ENUM.has(e)) return e;
  if (e) process.stderr.write('c-thru-config: unknown CLAUDE_LLM_MODE ' + JSON.stringify(e) + ', ignoring\n');
  const leg = process.env.CLAUDE_CONNECTIVITY_MODE || process.env.CLAUDE_LLM_CONNECTIVITY_MODE;
  if (leg) return leg === 'disconnect' ? 'offline' : 'connected';
  if (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) return config.llm_mode;
  if (config.llm_connectivity_mode) return config.llm_connectivity_mode === 'disconnect' ? 'offline' : 'connected';
  return 'connected';
}

// ── Tier resolution (mirrors hw-profile.js tierForGb) ──
function tierForGb(gb) {
  if (gb < 24) return '16gb';
  if (gb < 40) return '32gb';
  if (gb < 56) return '48gb';
  if (gb < 96) return '64gb';
  return '128gb';
}
function resolveActiveTier() {
  const override = process.env.CLAUDE_LLM_MEMORY_GB;
  if (override) {
    const gb = parseInt(override, 10);
    if (gb > 0) return tierForGb(gb);
  }
  const active = config.llm_active_profile;
  if (active && active !== 'auto') return active;
  return tierForGb(Math.ceil(os.totalmem() / (1024 ** 3)));
}

// ── Capability alias resolution (mirrors claude-proxy:445 resolveCapabilityAlias) ──
// TODO: dedupe with claude-proxy:445-463 (Phase 2 extraction)
const KNOWN_CAP_ALIASES = new Set([
  'judge', 'judge-strict', 'orchestrator', 'local-planner', 'code-analyst',
  'pattern-coder', 'deep-coder', 'commit-message-generator',
  'default', 'classifier', 'explorer', 'reviewer', 'workhorse', 'coder',
]);
function resolveCapabilityAlias(model) {
  if (KNOWN_CAP_ALIASES.has(model)) return model;
  const a2c = config.agent_to_capability;
  if (a2c && Object.prototype.hasOwnProperty.call(a2c, model)) return a2c[model];
  const tier = resolveActiveTier();
  const profile = (config.llm_profiles || {})[tier];
  if (profile && Object.prototype.hasOwnProperty.call(profile, model)) return model;
  return null;
}

// ── Profile model selection (mirrors claude-proxy:428 resolveProfileModel) ──
// TODO: dedupe with claude-proxy:428-438 (Phase 2 extraction)
function resolveProfileModel(entry, mode) {
  if (entry.modes && Object.prototype.hasOwnProperty.call(entry.modes, mode)) return entry.modes[mode];
  if (mode === 'offline') return entry.disconnect_model;
  if (mode === 'connected') return entry.connected_model;
  // semi-offload and cloud-judge-only default to local unless modes[] overrides
  if (mode === 'semi-offload' || mode === 'cloud-judge-only') return entry.disconnect_model;
  return entry.connected_model;
}

const mode = resolveLlmMode();
const tier = resolveActiveTier();
const capAlias = resolveCapabilityAlias(input);

if (!capAlias) {
  process.stderr.write('c-thru-config resolve: unknown capability or agent: ' + JSON.stringify(input) + '\n');
  process.exit(2);
}

const profiles = config.llm_profiles || {};
const profile = profiles[tier];
if (!profile) {
  process.stderr.write('c-thru-config resolve: no llm_profiles entry for tier ' + tier + '\n');
  process.exit(1);
}

const entry = profile[capAlias];
if (!entry || typeof entry !== 'object') {
  process.stderr.write('c-thru-config resolve: no profile entry for capability ' + JSON.stringify(capAlias) + ' in tier ' + tier + '\n');
  process.exit(2);
}

const resolved = resolveProfileModel(entry, mode);
if (typeof resolved !== 'string' || !resolved) {
  process.stderr.write('c-thru-config resolve: resolveProfileModel returned empty for ' + JSON.stringify(capAlias) + '\n');
  process.exit(1);
}

const modeSource = process.env.CLAUDE_LLM_MODE ? 'CLAUDE_LLM_MODE env'
  : (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) ? mapPath
  : 'default';
process.stdout.write(resolved + '\n');
process.stderr.write('  capability:  ' + capAlias + (input !== capAlias ? '  (via agent: ' + input + ')' : '') + '\n');
process.stderr.write('  mode:        ' + mode + '  (' + modeSource + ')\n');
process.stderr.write('  hw tier:     ' + tier + '\n');
process.stderr.write('  on_failure:  ' + (entry.on_failure || 'cascade') + '\n');
" -- "$ARGUMENTS_WORD_1"
```

Where `$ARGUMENTS_WORD_1` is the first word after the subcommand (the capability/agent name). If it is missing, print usage and stop.

Exit codes: 0 on resolved, 2 on unknown capability, 1 on config error.

---

## Subcommand: `mode`

**Usage:** `/c-thru-config mode` — show active mode and its source
**Usage:** `/c-thru-config mode <mode>` — persistently set mode

### Read (no argument):

```bash
node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const mapPath = path.join(CLAUDE_DIR, 'model-map.json');
const ovrPath = path.join(CLAUDE_DIR, 'model-map.overrides.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch {}
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(ovrPath, 'utf8')); } catch {}
const LLM_MODE_ENUM = new Set(['connected', 'semi-offload', 'cloud-judge-only', 'offline']);
const envMode = process.env.CLAUDE_LLM_MODE;
if (envMode && LLM_MODE_ENUM.has(envMode)) {
  console.log('mode: ' + envMode + '  (source: CLAUDE_LLM_MODE env — transient)');
} else if (overrides.llm_mode && LLM_MODE_ENUM.has(overrides.llm_mode)) {
  console.log('mode: ' + overrides.llm_mode + '  (source: ' + ovrPath + ')');
} else if (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) {
  console.log('mode: ' + config.llm_mode + '  (source: ' + mapPath + ' — system default)');
} else {
  console.log('mode: connected  (source: built-in default)');
}
"
```

### Write (`mode <mode>`):

Validate that `<mode>` is one of: `connected` | `semi-offload` | `cloud-judge-only` | `offline`.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  "{\"llm_mode\": \"<mode>\"}"
```

On success, print: `mode set to <mode> — run '/c-thru-config reload' to apply to running proxy`

---

## Subcommand: `remap`

**Usage:** `/c-thru-config remap <capability> <model> [--tier <tier>]`

Edits `llm_profiles[<active-tier>][<capability>]` in the user's overrides.
Default tier is the active hardware tier; `--tier <tier>` overrides it.

Parses `$ARGUMENTS` for the capability name, model name, and optional `--tier`.
If either capability or model is missing, print usage and stop.

Steps:
1. Determine active tier (from `CLAUDE_LLM_MEMORY_GB` env → `llm_active_profile` config → `tierForGb(os.totalmem())`), unless `--tier` provided.
2. Read `~/.claude/model-map.json` to get the current entry for the capability (to preserve `on_failure`, `modes`, etc.).
3. Replace only `connected_model` and `disconnect_model` with the new model (keep other fields).
4. Build the spec: `{"llm_profiles": {"<tier>": {"<cap>": {<merged entry>}}}}`
5. Run `model-map-edit`:

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  "<json-spec>"
```

On success, print:
```
remapped <capability> → <model>  (tier: <tier>)
run '/c-thru-config reload' to apply to running proxy
```

If the capability is unknown (not in `llm_profiles[tier]`), confirm with the user before creating a new entry.

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

Sends SIGHUP to the running proxy so it re-reads the config. If the proxy is not
running, prints a notice rather than an error.

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
PID_FILE="$CLAUDE_DIR/proxy.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "reload: no proxy PID file found at $PID_FILE — proxy may not be running"
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
    echo "reload: failed to send SIGHUP to pid $PID — try: pkill -HUP -f claude-proxy"
  fi
else
  echo "reload: pid $PID not running — proxy may have stopped"
  echo "  to restart: the next claude invocation via c-thru will auto-spawn it"
fi
```

---

## Subcommand: `diag`

**Usage:** `/c-thru-config diag [--verbose]`

Produces a single unified view: mode + source, hw tier, proxy status, capability
resolution table, backend health, and a stale-config notice if relevant.

Run these in sequence and combine the output:

### Step 1 — Mode and tier

```bash
node -e "
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR || path.join(os.homedir(), '.claude');
const mapPath = path.join(CLAUDE_DIR, 'model-map.json');
const ovrPath = path.join(CLAUDE_DIR, 'model-map.overrides.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch {}
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(ovrPath, 'utf8')); } catch {}
const LLM_MODE_ENUM = new Set(['connected', 'semi-offload', 'cloud-judge-only', 'offline']);
const envMode = process.env.CLAUDE_LLM_MODE;
let mode, modeSource;
if (envMode && LLM_MODE_ENUM.has(envMode)) {
  mode = envMode; modeSource = 'CLAUDE_LLM_MODE env (transient)';
} else if (overrides.llm_mode && LLM_MODE_ENUM.has(overrides.llm_mode)) {
  mode = overrides.llm_mode; modeSource = ovrPath;
} else if (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) {
  mode = config.llm_mode; modeSource = mapPath + ' (system default)';
} else {
  mode = 'connected'; modeSource = 'built-in default';
}
function tierForGb(gb) {
  if (gb < 24) return '16gb'; if (gb < 40) return '32gb';
  if (gb < 56) return '48gb'; if (gb < 96) return '64gb'; return '128gb';
}
const gbOverride = process.env.CLAUDE_LLM_MEMORY_GB;
const gb = gbOverride && parseInt(gbOverride, 10) > 0
  ? parseInt(gbOverride, 10)
  : Math.ceil(os.totalmem() / (1024 ** 3));
const activeProfile = config.llm_active_profile;
const tier = (activeProfile && activeProfile !== 'auto') ? activeProfile : tierForGb(gb);

console.log('mode:     ' + mode + '  (source: ' + modeSource + ')');
console.log('hw tier:  ' + tier + '  (' + gb + ' GB RAM detected)');

// Config staleness: compare model-map.json mtime vs proxy.pid mtime
const pidFile = path.join(CLAUDE_DIR, 'proxy.pid');
try {
  const mapMtime = fs.statSync(mapPath).mtimeMs;
  const pidMtime = fs.statSync(pidFile).mtimeMs;
  if (mapMtime > pidMtime) {
    console.log('');
    console.log('WARNING: config changed since proxy started — run /c-thru-config reload to apply');
  }
} catch {}

// Capability table
const CAPS = ['judge','judge-strict','orchestrator','local-planner','deep-coder','code-analyst','pattern-coder','commit-message-generator','default','workhorse','coder','reviewer','explorer','classifier'];
const profiles = config.llm_profiles || {};
const profile = profiles[tier] || {};
const a2c = config.agent_to_capability || {};
function resolveProfileModel(entry, m) {
  if (entry.modes && Object.prototype.hasOwnProperty.call(entry.modes, m)) return entry.modes[m];
  if (m === 'offline') return entry.disconnect_model;
  if (m === 'connected') return entry.connected_model;
  if (m === 'semi-offload' || m === 'cloud-judge-only') return entry.disconnect_model;
  return entry.connected_model;
}
console.log('');
console.log('Capability → model  (mode: ' + mode + ', tier: ' + tier + ')');
let maxLen = 0;
for (const cap of CAPS) { if (profile[cap]) maxLen = Math.max(maxLen, cap.length); }
for (const cap of CAPS) {
  const entry = profile[cap];
  if (!entry) continue;
  const resolved = resolveProfileModel(entry, mode);
  const tag = entry.on_failure === 'hard_fail' ? '  [hard_fail]' : '';
  console.log('  ' + cap.padEnd(maxLen + 2) + resolved + tag);
}

// Agent aliases (from agent_to_capability)
if (Object.keys(a2c).length > 0 && process.env.DIAG_VERBOSE === '1') {
  console.log('');
  console.log('Agent → capability mappings:');
  for (const [agent, cap] of Object.entries(a2c)) {
    console.log('  ' + agent + ' → ' + cap);
  }
}
"
```

### Step 2 — Proxy status

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
PID_FILE="$CLAUDE_DIR/proxy.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "proxy:    pid $PID  running"
    # Probe /ping for port
    PORT_FILE="$CLAUDE_DIR/proxy.port"
    if [ -f "$PORT_FILE" ]; then
      PORT=$(cat "$PORT_FILE" 2>/dev/null)
      if [ -n "$PORT" ]; then
        PING=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ping" 2>/dev/null || true)
        if [ -n "$PING" ]; then
          echo "          http://127.0.0.1:$PORT  healthy"
        else
          echo "          http://127.0.0.1:$PORT  no response"
        fi
      fi
    fi
  else
    echo ""
    echo "proxy:    not running  (pid file: $PID_FILE)"
  fi
else
  echo ""
  echo "proxy:    not running  (no pid file)"
fi
```

### Step 3 — Backend health (delegate to c-thru --list)

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
echo ""
echo "Backends:"
"$CLAUDE_DIR/tools/c-thru" --list 2>&1 | grep -E "^\s*(backend|ollama|anthropic|openrouter|ok|error|BACKEND)" | head -20 || true
```

For `--verbose`, also run Step 3 with full `c-thru --list` output unfiltered.

---

## Implementation notes

- Use `$ARGUMENTS` to extract subcommand and arguments. Parse positional args and flags from it.
- All paths default to `~/.claude/` but respect `CLAUDE_PROFILE_DIR` env override.
- For `model-map-edit` invocations, always pass all four arguments: defaults-path, overrides-path, effective-path, json-spec.
- `model-map-edit` tool is at `$CLAUDE_DIR/tools/model-map-edit` (symlinked by install.sh). `model-map-validate` is at `$CLAUDE_DIR/tools/model-map-validate`.
- If a tool is missing (not yet installed), print a clear error: `c-thru-config: model-map-edit not found — run ./install.sh first`.
