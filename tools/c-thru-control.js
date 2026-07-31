#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const baseUrl = process.env.ANTHROPIC_BASE_URL || '';

// C23 — per-user control token for mutating routes. Read the same 0600 file the
// proxy reads (env override mirrors the proxy's CLAUDE_PROXY_CONTROL_TOKEN*).
// Empty when absent → proxy fails open; no header sent.
function controlToken() {
  if (process.env.CLAUDE_PROXY_CONTROL_TOKEN) return process.env.CLAUDE_PROXY_CONTROL_TOKEN;
  const claudeDir = process.env.CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const tf = process.env.CLAUDE_PROXY_CONTROL_TOKEN_FILE || path.join(claudeDir, 'proxy.control-token');
  try { return fs.readFileSync(tf, 'utf8').trim() || null; } catch { return null; }
}
const CONTROL_TOKEN = controlToken();
if (!baseUrl) {
  console.error('c-thru-control: ANTHROPIC_BASE_URL not set — run from within a c-thru session or set CLAUDE_PROXY_PORT');
  process.exit(1);
}
const args = process.argv.slice(2);
const prompt = args.join(' ').toLowerCase();

// Helper for HTTP requests
function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}${urlPath}`);
    const hasBody = body !== null && body !== undefined;
    const bodyStr = hasBody ? JSON.stringify(body) : null;
    const headers = {};
    // Always set Content-Length on POST (including 0) so servers that wait for a
    // body (or Node's req 'end') do not hang on empty POSTs like /stats/clear.
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyStr ? Buffer.byteLength(bodyStr) : 0;
    }
    // C23: stamp the control token on mutating routes (/c-thru/mode, /reload,
    // /stats/clear). Harmless on GETs but only POSTs are gated; send for POST.
    if (method === 'POST' && CONTROL_TOKEN) headers['X-C-Thru-Control'] = CONTROL_TOKEN;
    const options = { method, headers };
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          try {
            const err = JSON.parse(data);
            // Anthropic-style errors nest an object: { error: { type, message } }
            const msg = typeof err.error === 'string' ? err.error : err.error?.message || `HTTP ${res.statusCode}`;
            return reject(new Error(msg));
          } catch {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', e => reject(new Error(`Proxy unreachable at ${baseUrl}`)));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function showStatus() {
  try {
    const s = await request('GET', '/c-thru/status');
    console.log(`\nC-thru Status [${s.mode}]:`);
    console.log(`  Tier:   ${s.hardware_tier}`);
    console.log(`  Source: ${s.config_source}`);
    console.log(`  Ollama: ${s.ollama_health}`);
    console.log('\nCapabilities:');
    for (const [k, v] of Object.entries(s.active_capabilities)) {
      console.log(`  ${k.padEnd(12)} ${v}`);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

async function setMode(mode, persist = false) {
  try {
    const res = await request('POST', '/c-thru/mode', { mode });
    console.log(`Success: ${res.message}`);

    if (persist) {
      console.log('Persisting to disk...');
      // Get paths from the config helper
      const configHelper = path.join(__dirname, '..', '..', '..', 'tools', 'model-map-config.js');
      const syncTool = path.join(__dirname, '..', '..', '..', 'tools', 'model-map-sync.js');
      const envRaw = spawnSync('node', [configHelper, '--shell-env'], { encoding: 'utf8' }).stdout;
      
      const defaultsMatch = envRaw.match(/MODEL_MAP_DEFAULTS_FILE="([^"]+)"/);
      const globalMatch = envRaw.match(/MODEL_MAP_OVERRIDES_FILE="([^"]+)"/);
      const projectMatch = envRaw.match(/_discovered_project_config="([^"]+)"/);
      const effectiveMatch = envRaw.match(/CLAUDE_MODEL_MAP_PATH="([^"]+)"/);

      if (defaultsMatch && globalMatch && effectiveMatch) {
        const defaultsPath = defaultsMatch[1];
        const globalPath = globalMatch[1];
        const projectPath = projectMatch ? projectMatch[1] : '';
        const effectivePath = effectiveMatch[1];

        // Read effective, change mode, sync. Persist the server's canonical
        // mode (res.new_mode), not the legacy input vocabulary.
        const config = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));
        config.llm_mode = res.new_mode || mode;
        const tmpPath = path.join(require('os').tmpdir(), `c-thru-persist-${process.pid}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(config));
        
        const syncResult = spawnSync(process.execPath, [
          syncTool, defaultsPath, globalPath, projectPath, effectivePath, tmpPath
        ]);
        fs.unlinkSync(tmpPath);
        
        if (syncResult.status === 0) {
          console.log(`Saved to ${projectPath || globalPath}`);
        } else {
          console.error('Failed to persist mode change.');
        }
      }
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

async function clearStats() {
  // F4: brief retries when the proxy returns 503 usage lock busy.
  const maxAttempts = 8;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await request('POST', '/c-thru/stats/clear');
      console.log(`Success: usage stats cleared${res.cleared_at ? ` at ${res.cleared_at}` : ''}`);
      console.log('(machine-wide lifetime ledger — not a single Claude session)');
      try {
        const s = await request('GET', '/c-thru/status');
        const u = s.usage || {};
        const calls = Object.values(u.by_model || {}).reduce((n, m) => n + (m.calls || 0), 0);
        console.log(`Usage totals (since clear): ${calls} calls  ${u.total_input || 0} in  ${u.total_output || 0} out`);
      } catch { /* optional */ }
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      if (/lock busy/i.test(msg) && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 150));
        continue;
      }
      break;
    }
  }
  console.error(`Error: ${lastErr ? lastErr.message : 'clear failed'}`);
  if (lastErr && /lock busy/i.test(String(lastErr.message || ''))) {
    console.error('(usage ledger lock busy — another proxy flush/clear in progress; try again)');
  }
  process.exit(1);
}

async function main() {
  // Explicit argv form: clear-stats / stats-clear
  const rawArg0 = (args[0] || '').toLowerCase();
  if (rawArg0 === 'clear-stats' || rawArg0 === 'stats-clear' || rawArg0 === 'clear_stats') {
    return clearStats();
  }

  if (!prompt || prompt === 'help' || prompt === 'status' || /how|status|health|what/.test(prompt)) {
    // Don't treat "clear stats" as a status query
    if (!/(clear|reset|zero).*(stat|usage)|(stat|usage).*(clear|reset|zero)/.test(prompt || '')) {
      return showStatus();
    }
  }

  if (/(clear|reset|zero).*(stat|usage)|(stat|usage).*(clear|reset|zero)/.test(prompt)) {
    return clearStats();
  }

  if (/offline|local|disconnect/.test(prompt)) {
    const persist = prompt.includes('persist') || prompt.includes('save') || prompt.includes('always');
    return setMode('offline', persist);
  }

  if (/online|connected|cloud/.test(prompt)) {
    const persist = prompt.includes('persist') || prompt.includes('save') || prompt.includes('always');
    return setMode('connected', persist);
  }

  if (/reload|refresh|update/.test(prompt)) {
    try {
      const res = await request('POST', '/c-thru/reload');
      console.log(`Success: ${res.message}`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  console.log(`C-thru: I don't know how to "${prompt}"`);
  console.log("Try: 'status', 'go offline', 'back online', 'reload config', or 'clear stats'");
}

main();
