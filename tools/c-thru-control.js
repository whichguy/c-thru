#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
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
    const options = {
      method,
      headers: body ? { 
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body))
      } : {}
    };
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          try {
            const err = JSON.parse(data);
            return reject(new Error(err.error || `HTTP ${res.statusCode}`));
          } catch {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', e => reject(new Error(`Proxy unreachable at ${baseUrl}`)));
    if (body) req.write(JSON.stringify(body));
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

        // Read effective, change mode, sync
        const config = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));
        config.llm_mode = mode;
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

async function main() {
  if (!prompt || prompt === 'help' || prompt === 'status' || /how|status|health|what/.test(prompt)) {
    return showStatus();
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
  console.log("Try: 'status', 'go offline', 'back online', or 'reload config'");
}

main();
