#!/usr/bin/env node
'use strict';
// Live contract test — reads each agent's system prompt, POSTs to the running proxy,
// and validates the STATUS block in the response.
// Tests routing AND prompt behavior without spawning a stub backend.
//
// Guard: set C_THRU_LIVE_AGENT_TESTS=1 to enable.
// Proxy: set CLAUDE_PROXY_URL or CLAUDE_PROXY_PORT, or start with c-thru --proxy.
// Run: C_THRU_LIVE_AGENT_TESTS=1 node test/agent-contract-live.test.js

const fs   = require('fs');
const http = require('http');
const path = require('path');

if (!process.env.C_THRU_LIVE_AGENT_TESTS) {
  console.log('agent-contract-live: skip (set C_THRU_LIVE_AGENT_TESTS=1 to enable)');
  process.exit(0);
}

const REPO_ROOT  = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const MAX_TOKENS = 800;
const PER_AGENT_TIMEOUT_MS = 60_000;

let passed  = 0;
let failed  = 0;
let skipped = 0;

function ok(label) {
  console.log(`  ok    ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  FAIL  ${label}`);
  if (reason) console.error(`        ${reason}`);
  failed++;
}

function skip(label, reason) {
  console.log(`  skip  ${label}${reason ? ' — ' + reason : ''}`);
  skipped++;
}

// ── STATUS block parser ───────────────────────────────────────────────────────
// Strip <think>…</think> blocks before parsing — some models emit CoT headers.
function parseStatusBlock(text) {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const r = {};
  for (const line of stripped.split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) r[m[1]] = m[2].trim();
  }
  return r;
}

// ── Proxy helpers ─────────────────────────────────────────────────────────────

function resolveProxy() {
  if (process.env.CLAUDE_PROXY_URL) {
    try {
      const u = new URL(process.env.CLAUDE_PROXY_URL);
      return { host: u.hostname, port: Number(u.port) || 80 };
    } catch { /* fall through */ }
  }
  return { host: '127.0.0.1', port: Number(process.env.CLAUDE_PROXY_PORT) || 9001 };
}

function pingProxy(host, port, timeoutMs = 8000) {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: host, port, path: '/ping', method: 'GET' },
      res => resolve(res.statusCode === 200)
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function postMessages(host, port, body, timeoutMs = PER_AGENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'Authorization':  `Bearer ${process.env.ANTHROPIC_API_KEY || 'live-test'}`,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(bodyText); } catch {}
          resolve({ status: res.statusCode, json, bodyText });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Agent file helpers ────────────────────────────────────────────────────────

function stripFrontmatter(content) {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

function readSystemPrompt(agentName) {
  const p = path.join(AGENTS_DIR, `${agentName}.md`);
  if (!fs.existsSync(p)) return null;
  return stripFrontmatter(fs.readFileSync(p, 'utf8'));
}

// ── Live roster ───────────────────────────────────────────────────────────────
// Each entry: { name, userMessage, extraChecks(block) → errorString|null }
// Only worker agents with a declared STATUS contract.

const LIVE_ROSTER = [
  {
    name: 'implementer',
    userMessage: "Digest: TASK: Append a comment '// hello' to an empty file. TARGET: /tmp/test.js. SCOPE: 1 line add.",
    extraChecks(r) {
      if (r.LINT_ITERATIONS !== undefined && !/^\d+$/.test(r.LINT_ITERATIONS))
        return `LINT_ITERATIONS must be non-negative integer (got "${r.LINT_ITERATIONS}")`;
      return null;
    },
  },
  {
    name: 'implementer-cloud',
    userMessage: "Digest: TASK: Append a comment '// hello' to an empty file. TARGET: /tmp/test.js. SCOPE: 1 line add.",
    extraChecks(r) {
      if (r.LINT_ITERATIONS !== undefined && !/^\d+$/.test(r.LINT_ITERATIONS))
        return `LINT_ITERATIONS must be non-negative integer (got "${r.LINT_ITERATIONS}")`;
      return null;
    },
  },
  {
    name: 'reviewer-fix',
    userMessage: "Review this code: console.log('hello'). Return STATUS block.",
    extraChecks(r) {
      if (r.STATUS !== 'RECUSE' && r.ITERATIONS === undefined) return 'ITERATIONS absent on non-RECUSE response';
      if (r.ITERATIONS !== undefined && !/^\d+$/.test(r.ITERATIONS))
        return `ITERATIONS must be non-negative integer (got "${r.ITERATIONS}")`;
      return null;
    },
  },
  {
    name: 'test-writer',
    userMessage: 'Write one test for: function add(a,b){return a+b}',
  },
  {
    name: 'test-writer-cloud',
    userMessage: 'Write one test for: function add(a,b){return a+b}',
  },
  {
    name: 'scaffolder',
    userMessage: 'Scaffold a minimal Node.js CLI entrypoint file.',
  },
  {
    name: 'converger',
    userMessage: 'Two parallel outputs both implement the same function identically. Output A: function f(){return 1} Output B: function f(){return 1}. Merge them.',
  },
  {
    name: 'integrator',
    userMessage: "Wire this function into a no-op Express router: function greet(){return 'hi'}",
  },
  {
    name: 'doc-writer',
    userMessage: 'Write a one-sentence docstring for: function add(a,b){return a+b}',
  },
  {
    name: 'explorer',
    userMessage: 'List JavaScript files in /tmp',
  },
  {
    name: 'discovery-advisor',
    userMessage: 'What should I investigate first in a codebase that has no tests?',
  },
  {
    name: 'security-reviewer',
    userMessage: 'Review: eval(userInput)',
  },
];

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_STATUS     = new Set(['COMPLETE', 'PARTIAL', 'ERROR', 'RECUSE']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

function validateBlock(agentName, block) {
  if (!VALID_STATUS.has(block.STATUS)) {
    fail(`${agentName}: STATUS "${block.STATUS}" not in {COMPLETE, PARTIAL, ERROR, RECUSE}`);
  } else {
    ok(`${agentName}: STATUS=${block.STATUS}`);
  }

  if (block.CONFIDENCE && !VALID_CONFIDENCE.has(block.CONFIDENCE)) {
    fail(`${agentName}: CONFIDENCE "${block.CONFIDENCE}" not in {high, medium, low}`);
  } else {
    ok(`${agentName}: CONFIDENCE=${block.CONFIDENCE || '(absent→medium)'}`);
  }

  if (!block.SUMMARY) {
    fail(`${agentName}: SUMMARY absent`);
  } else {
    ok(`${agentName}: SUMMARY present`);
  }

  if (block.STATUS === 'RECUSE') {
    if (!block.RECUSAL_REASON) {
      fail(`${agentName}: RECUSAL_REASON absent on RECUSE`);
    } else {
      ok(`${agentName}: RECUSAL_REASON present`);
    }

    // security-reviewer: ATTEMPTED + RECOMMEND must be absent (exception)
    if (agentName === 'security-reviewer') {
      if (block.RECOMMEND) {
        fail(`${agentName}: RECOMMEND must be absent (no cascade target)`);
      } else {
        ok(`${agentName}: RECOMMEND correctly absent (security-reviewer exception)`);
      }
    } else {
      if (!block.ATTEMPTED) {
        fail(`${agentName}: ATTEMPTED absent on RECUSE`);
      } else {
        ok(`${agentName}: ATTEMPTED=${block.ATTEMPTED}`);
      }
      if (!block.RECOMMEND) {
        fail(`${agentName}: RECOMMEND absent on RECUSE`);
      } else {
        ok(`${agentName}: RECOMMEND=${block.RECOMMEND}`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { host, port } = resolveProxy();

  process.stdout.write(`Checking proxy at ${host}:${port}… `);
  const alive = await pingProxy(host, port);
  if (!alive) {
    console.log('');
    console.log('agent-contract-live: SKIP — proxy not reachable');
    console.log('  Start with: c-thru --proxy   or set CLAUDE_PROXY_URL / CLAUDE_PROXY_PORT');
    process.exit(0);
  }
  console.log('ok\n');

  for (const entry of LIVE_ROSTER) {
    const { name, userMessage, extraChecks } = entry;

    const systemPrompt = readSystemPrompt(name);
    if (!systemPrompt) {
      skip(`${name}`, 'agent file not found');
      continue;
    }

    process.stdout.write(`  [${name}] … `);
    let res;
    try {
      res = await postMessages(host, port, {
        model:      name,
        max_tokens: MAX_TOKENS,
        stream:     false,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      });
    } catch (e) {
      console.log('');
      skip(`${name}: request failed — ${e.message}`);
      continue;
    }
    console.log(`HTTP ${res.status}`);

    if (res.status !== 200) {
      fail(`${name}: proxy returned HTTP ${res.status}`, res.bodyText.slice(0, 300));
      continue;
    }

    const text = res.json && Array.isArray(res.json.content)
      ? res.json.content.map(c => (c != null && typeof c === 'object' && c.text) ? c.text : '').join('')
      : res.bodyText;

    const block = parseStatusBlock(text);

    if (!block.STATUS) {
      skip(`${name}: no STATUS block in response (truncation — try increasing MAX_TOKENS)`);
      continue;
    }

    validateBlock(name, block);

    if (extraChecks) {
      const err = extraChecks(block);
      if (err) {
        fail(`${name}: ${err}`);
      } else {
        ok(`${name}: agent-specific field check passed`);
      }
    }
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
