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
const { parseStatusBlock, tierTimeout } = require('./helpers');

if (!process.env.C_THRU_LIVE_AGENT_TESTS) {
  console.log('agent-contract-live: skip (set C_THRU_LIVE_AGENT_TESTS=1 to enable)');
  process.exit(0);
}

const REPO_ROOT  = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const MAX_TOKENS = 1200;
const PER_AGENT_TIMEOUT_MS = 60_000;

let passed           = 0;
let failed           = 0;
let skippedExpected  = 0;
let skippedUnexpected = 0;

// Cloud/judge tiers where 401/403 is expected when ANTHROPIC_API_KEY is absent.
const CLOUD_TIERS = new Set(['judge', 'judge-strict', 'deep-coder-cloud', 'code-analyst-cloud']);

function ok(label) {
  console.log(`  ok    ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  FAIL  ${label}`);
  if (reason) console.error(`        ${reason}`);
  failed++;
}

function skipExpected(label, reason) {
  console.log(`  skip  ${label}${reason ? ' — ' + reason : ''} (expected)`);
  skippedExpected++;
}

function skipUnexpected(label, reason) {
  console.log(`  SKIP! ${label}${reason ? ' — ' + reason : ''} (UNEXPECTED)`);
  skippedUnexpected++;
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
          resolve({ status: res.statusCode, headers: res.headers, json, bodyText });
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
    expectedCapability: 'deep-coder',
    userMessage: "Digest: TASK: Append a comment '// hello' to an empty file. TARGET: /tmp/test.js. SCOPE: 1 line add.",
    extraChecks(r) {
      if (r.LINT_ITERATIONS !== undefined && !/^\d+$/.test(r.LINT_ITERATIONS))
        return `LINT_ITERATIONS must be non-negative integer (got "${r.LINT_ITERATIONS}")`;
      return null;
    },
  },
  {
    name: 'implementer-cloud',
    expectedCapability: 'deep-coder-cloud',
    userMessage: "Digest: TASK: Append a comment '// hello' to an empty file. TARGET: /tmp/test.js. SCOPE: 1 line add.",
    extraChecks(r) {
      if (r.LINT_ITERATIONS !== undefined && !/^\d+$/.test(r.LINT_ITERATIONS))
        return `LINT_ITERATIONS must be non-negative integer (got "${r.LINT_ITERATIONS}")`;
      return null;
    },
  },
  {
    name: 'wave-reviewer',
    expectedCapability: 'code-analyst',
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
    expectedCapability: 'code-analyst',
    userMessage: 'Write one test for: function add(a,b){return a+b}',
  },
  {
    name: 'test-writer-cloud',
    expectedCapability: 'code-analyst-cloud',
    userMessage: 'Write one test for: function add(a,b){return a+b}',
  },
  {
    name: 'scaffolder',
    expectedCapability: 'pattern-coder',
    userMessage: 'Scaffold a minimal Node.js CLI entrypoint file.',
  },
  {
    name: 'converger',
    expectedCapability: 'code-analyst',
    userMessage: 'Two parallel outputs both implement the same function identically. Output A: function f(){return 1} Output B: function f(){return 1}. Merge them.',
  },
  {
    name: 'integrator',
    expectedCapability: 'orchestrator',
    userMessage: "Wire this function into a no-op Express router: function greet(){return 'hi'}",
  },
  {
    name: 'doc-writer',
    expectedCapability: 'orchestrator',
    userMessage: 'Write a one-sentence docstring for: function add(a,b){return a+b}',
  },
  {
    name: 'explorer',
    expectedCapability: 'pattern-coder',
    userMessage: 'List JavaScript files in /tmp',
  },
  {
    name: 'discovery-advisor',
    expectedCapability: 'pattern-coder',
    userMessage: 'What should I investigate first in a codebase that has no tests?',
  },
  {
    name: 'security-reviewer',
    expectedCapability: 'judge-strict',
    userMessage: 'Review: eval(userInput)',
  },
  {
    name: 'auditor',
    expectedCapability: 'judge',
    userMessage: 'replan_brief: /tmp/test-brief.md\ndecision_out: /tmp/test-decision.json\n\nWave 001 outcome: partial. 1 of 3 items completed (item-001). Items 2 and 3 timed out. Intent: add authentication middleware.',
  },
  {
    name: 'final-reviewer',
    expectedCapability: 'judge',
    userMessage: 'All items complete. Plan: add user auth. Outcome: implemented JWT middleware, protected routes, added tests. All items status:complete. Review and confirm plan is met.',
  },
  {
    name: 'journal-digester',
    expectedCapability: 'judge',
    userMessage: 'journal_path: /tmp/test-journal.md\noutput_path: /tmp/test-digest.md\n\nJournal: Wave 001 complete. Discovery found no test framework. Implementer added Jest config.',
  },
  {
    name: 'learnings-consolidator',
    expectedCapability: 'pattern-coder',
    userMessage: 'findings_paths: []\noutput_path: /tmp/test-learnings.md\n\nLearning 1: system prompts too verbose. Learning 2: test coverage missing for edge cases.',
  },
  {
    name: 'plan-orchestrator',
    expectedCapability: 'orchestrator',
    userMessage: 'current.md: /tmp/current.md\nREADY_ITEMS: [item-001]\ncommit_message: feat: add greeting module\nwave_dir: /tmp/wave-001',
  },
  {
    name: 'planner',
    expectedCapability: 'judge',
    userMessage: 'current.md: /tmp/current.md\nsignal: intent\noutcome: build a hello-world CLI\n\nItems:\n- id: item-001, status: pending, agent: implementer, depends_on: []',
  },
  {
    name: 'review-plan',
    expectedCapability: 'judge',
    userMessage: 'current.md: /tmp/current.md\nreview_out: /tmp/review-001.md\n\nPlan: 1 item, no deps, outcome: add greet function. Item: id:item-001 status:pending target:src/greet.js',
  },
  {
    name: 'wave-synthesizer',
    expectedCapability: 'code-analyst',
    userMessage: 'wave_dir: /tmp/wave-001\nreplan_brief_out: /tmp/replan-brief.md\noutcome: partial\nreason: item-002 timed out\ncompleted: [item-001]\nfailed: [item-002]',
  },
  {
    name: 'planner-local',
    expectedCapability: 'local-planner',
    userMessage: 'current.md: /tmp/current.md\nsignal: dep_update\nwave_summary: /tmp/wave-summary.json\naffected_items: [item-001]',
  },
  {
    name: 'uplift-decider',
    expectedCapability: 'judge',
    userMessage: 'PARTIAL_OUTPUT: /tmp/impl-output.md\nmode: uplift\nRecusal reason: cannot confirm lint pass.\nPrior agent: implementer, tier: deep-coder, attempted: yes',
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
    const { name, expectedCapability, userMessage, extraChecks } = entry;

    const systemPrompt = readSystemPrompt(name);
    if (!systemPrompt) {
      skipUnexpected(`${name}`, 'agent file not found');
      continue;
    }

    const timeout = tierTimeout(expectedCapability, PER_AGENT_TIMEOUT_MS);
    process.stdout.write(`  [${name}] … `);
    let res;
    try {
      res = await postMessages(host, port, {
        model:      name,
        max_tokens: MAX_TOKENS,
        stream:     false,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      }, timeout);
    } catch (e) {
      console.log('');
      skipUnexpected(`${name}`, `request failed — ${e.message}`);
      continue;
    }
    console.log(`HTTP ${res.status}`);

    if (res.status === 401 || res.status === 403) {
      if (CLOUD_TIERS.has(expectedCapability)) {
        skipExpected(`${name}`, `HTTP ${res.status} — cloud backend auth not configured`);
      } else {
        skipUnexpected(`${name}`, `HTTP ${res.status} — unexpected auth error on local tier`);
      }
      continue;
    }
    if (res.status !== 200) {
      fail(`${name}: proxy returned HTTP ${res.status}`, res.bodyText.slice(0, 300));
      continue;
    }

    // Verify the response came through c-thru with agent-name resolution.
    const resolvedVia = res.headers && res.headers['x-c-thru-resolved-via'];
    if (!resolvedVia) {
      fail(`${name}: x-c-thru-resolved-via header absent — response did not come through c-thru proxy`);
    } else {
      try {
        const via = JSON.parse(resolvedVia);
        ok(`${name}: routed through c-thru → served_by=${via.served_by} capability=${via.capability} tier=${via.tier}`);
        if (via.served_by === name) {
          fail(`${name}: served_by equals agent name — agent_to_capability resolution did not fire`);
        } else {
          ok(`${name}: agent name resolved (served_by "${via.served_by}" ≠ agent name "${name}")`);
        }
        if (!via.served_by) {
          fail(`${name}: served_by is null/empty — no model was resolved`);
        }
        if (expectedCapability && via.capability !== expectedCapability) {
          fail(`${name}: capability "${via.capability}" expected "${expectedCapability}"`);
        } else if (expectedCapability) {
          ok(`${name}: capability matches expected (${expectedCapability})`);
        }
      } catch (e) {
        fail(`${name}: x-c-thru-resolved-via is not valid JSON — ${e.message}`);
      }
    }

    const text = res.json && Array.isArray(res.json.content)
      ? res.json.content.map(c => (c != null && typeof c === 'object' && c.text) ? c.text : '').join('')
      : res.bodyText;

    const block = parseStatusBlock(text);

    if (!block.STATUS) {
      skipUnexpected(`${name}`, 'no STATUS block in response (truncation — try increasing MAX_TOKENS)');
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

  const total = passed + failed + skippedExpected + skippedUnexpected;
  const skippedParts = [];
  if (skippedExpected)   skippedParts.push(`${skippedExpected} skipped (expected)`);
  if (skippedUnexpected) skippedParts.push(`${skippedUnexpected} skipped (UNEXPECTED)`);
  const skippedSummary = skippedParts.length ? `, ${skippedParts.join(', ')}` : '';
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed${skippedSummary}`);
  process.exit(failed || skippedUnexpected ? 1 : 0);
}

// unhandledRejection handler is installed by helpers.js on require.
main().catch(err => {
  console.error(err);
  process.exit(1);
});
