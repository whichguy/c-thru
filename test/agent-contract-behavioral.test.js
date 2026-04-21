#!/usr/bin/env node
'use strict';
// Behavioral contract tests — writes realistic digest fixtures, calls the proxy,
// and asserts specific STATUS values and field content (not just structure).
//
// Guard:   C_THRU_BEHAVIORAL_TESTS=1
// Proxy:   CLAUDE_PROXY_URL or CLAUDE_PROXY_PORT
// Filter:  BEHAVIORAL_ONLY=discovery-advisor,explorer  (comma-separated subset)
// Run:     C_THRU_BEHAVIORAL_TESTS=1 node test/agent-contract-behavioral.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');
const {
  parseStatusBlock,
  stripBehavioralContract,
  tierTimeout,
  registerTmpDir,
  installExitHandlers,
} = require('./helpers');

if (!process.env.C_THRU_BEHAVIORAL_TESTS) {
  console.log('agent-contract-behavioral: skip (set C_THRU_BEHAVIORAL_TESTS=1 to enable)');
  process.exit(0);
}

const REPO_ROOT       = path.resolve(__dirname, '..');
const AGENTS_DIR      = path.join(REPO_ROOT, 'agents');
const CONTRACT_FILE   = path.join(REPO_ROOT, 'shared', '_worker-contract.md');
const WORKER_CONTRACT = fs.readFileSync(CONTRACT_FILE, 'utf8');

// Behavioral-test variant: strips the post-work linting section.
// Raw API calls have no tool use — models can't run node --check, so the
// full contract causes recusal on "cannot establish output is correct".
const BEHAVIORAL_WORKER_CONTRACT = stripBehavioralContract(WORKER_CONTRACT);

const FILTER = process.env.BEHAVIORAL_ONLY
  ? new Set(process.env.BEHAVIORAL_ONLY.split(',').map(s => s.trim()))
  : null;

let passed           = 0;
let failed           = 0;
let skippedExpected  = 0;
let skippedUnexpected = 0;
const advisory = [];

// Cloud/judge tiers where 401/403 is expected when ANTHROPIC_API_KEY is absent.
const CLOUD_TIERS = new Set(['judge', 'judge-strict', 'deep-coder-cloud', 'code-analyst-cloud']);

// Tiers served by Qwen3 models that need /no_think in the system prompt.
const QWEN3_TIERS = new Set(['pattern-coder', 'orchestrator', 'local-planner']);

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

function adv(label) {
  advisory.push(label);
  console.log(`  adv   ${label}`);
}

// ── Proxy helpers ─────────────────────────────────────────────────────────────
function resolveProxy() {
  if (process.env.CLAUDE_PROXY_URL) {
    try {
      const u = new URL(process.env.CLAUDE_PROXY_URL);
      return { host: u.hostname, port: Number(u.port) || 80 };
    } catch {}
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

function postMessages(host, port, body, timeoutMs = 120_000) {
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
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`timed out after ${timeoutMs}ms`)); });
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

// ── Digest builder: standard worker digest + injected worker contract ─────────
function buildWorkerDigest(tmpDir, agentName, itemId, targetResources, taskBody) {
  const frontmatter = [
    '---',
    `agent: ${agentName}`,
    `item_id: ${itemId}`,
    'wave: "001"',
    `target_resources: [${targetResources.join(', ')}]`,
    '---',
  ].join('\n');
  const content = frontmatter + '\n\n' + taskBody.trim() + '\n\n---\n\n' + BEHAVIORAL_WORKER_CONTRACT;
  // Write to disk for debugging; return contents (not path) so the model can read them.
  fs.writeFileSync(path.join(tmpDir, `${agentName}-${itemId}.md`), content, 'utf8');
  return content;
}

// ── Validate helpers ──────────────────────────────────────────────────────────
const VALID_STATUS     = new Set(['COMPLETE', 'PARTIAL', 'ERROR', 'RECUSE']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

// Returns false if STATUS is fundamentally invalid (caller should stop).
function validateBase(agentName, block) {
  if (!VALID_STATUS.has(block.STATUS)) {
    fail(`${agentName}: STATUS "${block.STATUS}" not in {COMPLETE, PARTIAL, ERROR, RECUSE}`);
    return false;
  }
  ok(`${agentName}: STATUS=${block.STATUS}`);
  if (block.CONFIDENCE && !VALID_CONFIDENCE.has(block.CONFIDENCE)) {
    fail(`${agentName}: CONFIDENCE "${block.CONFIDENCE}" invalid`);
  } else {
    ok(`${agentName}: CONFIDENCE=${block.CONFIDENCE || '(absent→medium)'}`);
  }
  if (!block.SUMMARY) {
    fail(`${agentName}: SUMMARY absent`);
  } else {
    ok(`${agentName}: SUMMARY present`);
  }
  return true;
}

function assertWorkSection(agentName, text, advisory = false) {
  if (!text.includes('## Work completed')) {
    if (advisory) {
      adv(`${agentName}: "## Work completed" section absent (local model format compliance — advisory)`);
    } else {
      fail(`${agentName}: "## Work completed" section absent from response`);
    }
  } else {
    ok(`${agentName}: "## Work completed" section present`);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function runTest(host, port, entry) {
  const { name, maxTokens, expectedCapability, buildMessage, validate } = entry;

  if (FILTER && !FILTER.has(name)) return;

  const systemPrompt = readSystemPrompt(name);
  if (!systemPrompt) {
    skipUnexpected(`${name}`, 'agent file not found');
    return;
  }

  const tmpDir = registerTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), `c-thru-beh-${name}-`)));
  let userMessage;
  try {
    userMessage = buildMessage(tmpDir);
  } catch (e) {
    fail(`${name}: fixture build failed — ${e.message}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return;
  }

  // Prepend /no_think to system prompt for Qwen3-served tiers to suppress
  // extended-thinking token drain without corrupting KV-format user messages.
  const sysPrompt = QWEN3_TIERS.has(expectedCapability)
    ? `/no_think\n\n${systemPrompt}`
    : systemPrompt;

  process.stdout.write(`  [${name}] … `);
  let res;
  try {
    res = await postMessages(host, port, {
      model:      name,
      max_tokens: maxTokens || 3000,
      stream:     false,
      system:     sysPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }, entry.timeoutMs || tierTimeout(expectedCapability));
  } catch (e) {
    console.log('');
    skipUnexpected(`${name}`, `request failed — ${e.message}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return;
  }
  console.log(`HTTP ${res.status}`);

  try {
    if (res.status === 401 || res.status === 403) {
      if (CLOUD_TIERS.has(expectedCapability)) {
        skipExpected(`${name}`, `HTTP ${res.status} — cloud backend auth not configured`);
      } else {
        skipUnexpected(`${name}`, `HTTP ${res.status} — unexpected auth error on local tier`);
      }
      return;
    }
    if (res.status !== 200) {
      fail(`${name}: HTTP ${res.status}`, res.bodyText.slice(0, 300));
      return;
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
      skipUnexpected(`${name}`, `no STATUS block in response (text length: ${text.length} chars — increase maxTokens or check routing)`);
      return;
    }

    validate(name, block, text);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Behavioral roster ─────────────────────────────────────────────────────────
// Phase 1: high-confidence deterministic assertions
// Phase 2: worker agents — STATUS + work-section assertions
// Phase 3: cloud agents (skip on 401) + planner-local

const ROSTER = [

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 1: non-worker agents with deterministic/near-deterministic outcomes
  // ─────────────────────────────────────────────────────────────────────────────

  // 1. discovery-advisor: no-gaps recon → GAPS=0
  // Agent spec: "If the reconnaissance summary contains `no-gaps`... return GAPS: 0"
  // Recon content is inlined so the model doesn't need filesystem tool use.
  {
    name: 'discovery-advisor',
    expectedCapability: 'pattern-coder',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      const reconContent = '# Reconnaissance summary\n\nno-gaps\n\nGreenfield project with no existing code to survey.\n';
      const reconPath = path.join(tmpDir, 'recon.md');
      const gapsOut   = path.join(tmpDir, 'gaps.md');
      fs.writeFileSync(reconPath, reconContent);
      return [
        `intent: add user authentication to a new Node.js project`,
        `recon_path: ${reconPath}`,
        `gaps_out: ${gapsOut}`,
        ``,
        `Contents of recon.md:`,
        reconContent.trim(),
      ].join('\n');
    },
    validate(name, block) {
      validateBase(name, block);
      if (block.STATUS === 'COMPLETE') {
        if (block.GAPS === '0') {
          ok(`${name}: GAPS=0 (greenfield shortcut fired as per spec)`);
        } else {
          fail(`${name}: expected GAPS=0 for no-gaps recon, got GAPS="${block.GAPS}"`);
        }
        if (block.WROTE) {
          ok(`${name}: WROTE present`);
        } else {
          fail(`${name}: WROTE absent`);
        }
      }
    },
  },

  // 2. explorer: literal-answer question → ANSWERED=yes
  // File contents are inlined so the model doesn't need filesystem tool use.
  {
    name: 'explorer',
    expectedCapability: 'pattern-coder',
    maxTokens: 2000,
    buildMessage(tmpDir) {
      const configPath = path.join(tmpDir, 'config.js');
      const configContent = "'use strict';\nconst PORT = 3000;\nmodule.exports = { PORT };\n";
      fs.mkdirSync(path.join(tmpDir, 'discovery'), { recursive: true });
      const outPath = path.join(tmpDir, 'discovery', 'config-port.md');
      fs.writeFileSync(configPath, configContent);
      // Include file contents inline so the model can answer without tool use.
      return [
        `gap_question: What is the value of the PORT constant in config.js?`,
        `output_path: ${outPath}`,
        ``,
        `File contents of config.js:`,
        `\`\`\`js`,
        configContent.trim(),
        `\`\`\``,
      ].join('\n');
    },
    validate(name, block) {
      if (!validateBase(name, block)) return;
      if (['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
        if (!['yes', 'partial'].includes(block.ANSWERED)) {
          fail(`${name}: ANSWERED="${block.ANSWERED}" expected yes|partial for literal-answer question`);
        } else {
          ok(`${name}: ANSWERED=${block.ANSWERED}`);
        }
        if (block.WROTE) {
          ok(`${name}: WROTE present`);
        } else {
          fail(`${name}: WROTE absent`);
        }
      }
    },
  },

  // 3. uplift-decider: partial output matches all criteria → VERDICT accept
  {
    name: 'uplift-decider',
    expectedCapability: 'judge',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'outputs'), { recursive: true });
      const partialOutput = path.join(tmpDir, 'outputs', 'implementer-item-001.md');
      const partialText = `## Work completed
Appended \`// behavioral-test-marker\` as the final line of src/hello.js.

The file now ends with the comment \`// behavioral-test-marker\` and passes \`node --check\`.

### Learnings
Target file was syntactically valid before modification.
`;
      fs.writeFileSync(partialOutput, partialText);
      const digestContent = `---
agent: uplift-decider
item_id: item-behavioral-001
wave: "001"
target_resources: [src/hello.js]
---

## Mission context
Behavioral test. Evaluate whether the partial implementer output satisfies the success criteria.

## Your task
Append \`// behavioral-test-marker\` as the final line of src/hello.js.

Success criteria:
- [ ] src/hello.js ends with the line \`// behavioral-test-marker\`
- [ ] File passes node --check

## Escalation context
PARTIAL_OUTPUT: ${partialOutput}
mode: uplift
Recusal reason: local implementer could not confirm output passes lint check.

Prior escalation log:
- agent: implementer, tier: deep-coder, attempted: yes

Contents of PARTIAL_OUTPUT:
\`\`\`
${partialText.trim()}
\`\`\`
`;
      fs.writeFileSync(path.join(tmpDir, 'uplift-decider-item-001.md'), digestContent);
      return digestContent;
    },
    validate(name, block) {
      if (block.STATUS !== 'COMPLETE') {
        fail(`${name}: STATUS="${block.STATUS}" expected COMPLETE`);
        return;
      }
      ok(`${name}: STATUS=COMPLETE`);
      if (!block.SUMMARY) {
        fail(`${name}: SUMMARY absent`);
      } else {
        ok(`${name}: SUMMARY present`);
      }
      if (!['accept', 'uplift', 'restart'].includes(block.VERDICT)) {
        fail(`${name}: VERDICT "${block.VERDICT}" not in {accept, uplift, restart}`);
      } else {
        ok(`${name}: VERDICT=${block.VERDICT}`);
        if (block.VERDICT !== 'accept') {
          adv(`${name}: expected VERDICT=accept (partial fully satisfies criteria) — model was conservative`);
        }
      }
      if (!VALID_CONFIDENCE.has(block.CLOUD_CONFIDENCE)) {
        fail(`${name}: CLOUD_CONFIDENCE "${block.CLOUD_CONFIDENCE}" not in {high, medium, low}`);
      } else {
        ok(`${name}: CLOUD_CONFIDENCE=${block.CLOUD_CONFIDENCE}`);
      }
      if (!block.RATIONALE) {
        fail(`${name}: RATIONALE absent`);
      } else {
        ok(`${name}: RATIONALE present`);
      }
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 2: worker agents — STATUS + work section + agent-specific fields
  // ─────────────────────────────────────────────────────────────────────────────

  // 4. implementer: append comment to clean JS → COMPLETE, LINT_ITERATIONS numeric
  {
    name: 'implementer',
    expectedCapability: 'deep-coder',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const helloJs = path.join(tmpDir, 'src', 'hello.js');
      fs.writeFileSync(helloJs,
        "'use strict';\nfunction hello() { return 42; }\nmodule.exports = hello;\n");
      const taskBody = `## Mission context
Behavioral test. Append a marker comment to a syntactically valid JS file.

## Prior wave context
No prior wave output.

## Your task
Append the comment \`// behavioral-test-marker\` as the final line of \`${helloJs}\`.
Do not change any other line.

The file currently contains:
\`\`\`js
'use strict';
function hello() { return 42; }
module.exports = hello;
\`\`\`

Success criteria:
- [ ] \`${helloJs}\` ends with the line \`// behavioral-test-marker\`
- [ ] File remains syntactically valid JavaScript

## Constraints
Only modify \`${helloJs}\`. No other files.`;
      return buildWorkerDigest(tmpDir, 'implementer', 'item-behavioral-001', [helloJs], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
        assertWorkSection(name, text);
        if (text.includes('behavioral-test-marker')) {
          ok(`${name}: expected marker content present in work output`);
        } else {
          adv(`${name}: behavioral-test-marker not found in response (may use diff format)`);
        }
        if (block.LINT_ITERATIONS !== undefined) {
          if (/^\d+$/.test(block.LINT_ITERATIONS)) {
            ok(`${name}: LINT_ITERATIONS=${block.LINT_ITERATIONS} (valid integer)`);
          } else {
            fail(`${name}: LINT_ITERATIONS "${block.LINT_ITERATIONS}" not a non-negative integer`);
          }
        } else {
          ok(`${name}: LINT_ITERATIONS absent (treated as 0 per spec)`);
        }
      }
    },
  },

  // 5. security-reviewer: pure math utility → STATUS must NOT be RECUSE
  {
    name: 'security-reviewer',
    expectedCapability: 'judge-strict',
    maxTokens: 3000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const mathUtils = path.join(tmpDir, 'src', 'math-utils.js');
      fs.writeFileSync(mathUtils,
        "'use strict';\nfunction add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n");
      const taskBody = `## Mission context
Behavioral test. Security review of a pure math utility — no auth boundaries.

## Your task
Review \`${mathUtils}\` for security vulnerabilities.

Success criteria:
- [ ] All code reviewed for injection, auth bypass, secrets, unsafe operations
- [ ] Findings documented

## Constraints
Review only \`${mathUtils}\`. No other files.`;
      return buildWorkerDigest(tmpDir, 'security-reviewer', 'item-behavioral-001', [mathUtils], taskBody);
    },
    validate(name, block) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'RECUSE') {
        fail(`${name}: STATUS=RECUSE on non-auth code — recusal condition must not fire for pure math utility`);
      } else {
        ok(`${name}: STATUS=${block.STATUS} (RECUSE correctly did not fire on non-auth code)`);
      }
    },
  },

  // 6. scaffolder: explicit stub spec → COMPLETE, work section present
  {
    name: 'scaffolder',
    expectedCapability: 'pattern-coder',
    maxTokens: 6000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const stubJs = path.join(tmpDir, 'src', 'greeter.js');
      const taskBody = `## Mission context
Behavioral test. Scaffold a minimal Node.js module stub.

## Your task
Create stub file at \`${stubJs}\` following this exact pattern:
- Named export \`greet\` with a \`// TODO: implement\` body marker
- Use \`module.exports = { greet };\` at the bottom

Success criteria:
- [ ] \`${stubJs}\` contains a function stub named \`greet\`
- [ ] Contains \`// TODO: implement\` marker
- [ ] Exports greet via \`module.exports = { greet }\`

## Constraints
Only create \`${stubJs}\`. No other files.`;
      return buildWorkerDigest(tmpDir, 'scaffolder', 'item-behavioral-001', [stubJs], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'COMPLETE') {
        assertWorkSection(name, text, /* advisory */ true);
        if (text.includes('greet')) {
          ok(`${name}: expected function name "greet" present in work output`);
        } else {
          adv(`${name}: "greet" not found in response (model may have renamed it)`);
        }
      }
    },
  },

  // 7. wave-reviewer: clean JS file → STATUS valid, ITERATIONS numeric
  {
    name: 'wave-reviewer',
    expectedCapability: 'code-analyst',
    maxTokens: 6000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const adderJs = path.join(tmpDir, 'src', 'adder.js');
      fs.writeFileSync(adderJs,
        "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n");
      const taskBody = `## Mission context
Behavioral test. Review a simple, clean JavaScript utility.

## Your task
Review \`${adderJs}\` for correctness, security, and conventions. Apply any fixes needed.

Success criteria:
- [ ] All issues identified and addressed
- [ ] File is correct, secure, and follows conventions

## Constraints
Only write to \`${adderJs}\`. No other files.`;
      return buildWorkerDigest(tmpDir, 'wave-reviewer', 'item-behavioral-001', [adderJs], taskBody);
    },
    validate(name, block) {
      if (!validateBase(name, block)) return;
      if (block.STATUS !== 'RECUSE') {
        if (block.ITERATIONS === undefined) {
          fail(`${name}: ITERATIONS absent on non-RECUSE response`);
        } else if (/^\d+$/.test(block.ITERATIONS)) {
          ok(`${name}: ITERATIONS=${block.ITERATIONS} (valid integer)`);
        } else {
          fail(`${name}: ITERATIONS "${block.ITERATIONS}" not a non-negative integer`);
        }
      }
    },
  },

  // 8. test-writer: simple add function → COMPLETE, work section present
  {
    name: 'test-writer',
    expectedCapability: 'code-analyst',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'),  { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
      const addJs  = path.join(tmpDir, 'src', 'add.js');
      const testJs = path.join(tmpDir, 'test', 'add.test.js');
      fs.writeFileSync(addJs,
        "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n");
      const taskBody = `## Mission context
Behavioral test. Write tests for a simple add function.

## Implementation to test
Read \`${addJs}\` before writing tests.

## Your task
Write tests for the \`add\` function into \`${testJs}\`.

Success criteria:
- [ ] \`${testJs}\` contains at least one test for \`add(1, 2) === 3\`
- [ ] Tests cover basic arithmetic correctness

## Constraints
Write only to \`${testJs}\`. Read \`${addJs}\` to understand the implementation.`;
      return buildWorkerDigest(tmpDir, 'test-writer', 'item-behavioral-001', [testJs], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'COMPLETE') {
        assertWorkSection(name, text);
        if (text.includes('add(1') || text.includes('add(1,')) {
          ok(`${name}: test case for add(1, ...) present in work output`);
        } else {
          adv(`${name}: expected add(1,...) test case not found in response`);
        }
      }
    },
  },

  // 9. converger: two identical parallel outputs → COMPLETE
  {
    name: 'converger',
    expectedCapability: 'code-analyst',
    maxTokens: 6000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'outputs'), { recursive: true });
      const sharedContent = `## Work completed
Added \`function greet() { return 'hello'; }\` to src/greeter.js.
Export: \`module.exports = { greet };\`

### Learnings
Simple export pattern used consistently in this codebase.
`;
      const outputA   = path.join(tmpDir, 'outputs', 'impl-A-item-001.md');
      const outputB   = path.join(tmpDir, 'outputs', 'impl-B-item-001.md');
      const mergedOut = path.join(tmpDir, 'outputs', 'converger-item-001.md');
      fs.writeFileSync(outputA, sharedContent);
      fs.writeFileSync(outputB, sharedContent);
      const taskBody = `## Mission context
Behavioral test. Converge two parallel implementer outputs that are identical.

## Your task
Read and converge these two parallel outputs (they are identical — no conflict):
- Output A: ${outputA}
- Output B: ${outputB}

Produce a single unified output at \`${mergedOut}\`.

Success criteria:
- [ ] Unified output written to \`${mergedOut}\`
- [ ] No conflicts (both inputs are identical)
- [ ] All content preserved

## Constraints
Write only to \`${mergedOut}\`.`;
      return buildWorkerDigest(tmpDir, 'converger', 'item-behavioral-001', [mergedOut], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'COMPLETE') {
        assertWorkSection(name, text);
      }
    },
  },

  // 10. integrator: wire module into index → COMPLETE
  {
    name: 'integrator',
    expectedCapability: 'orchestrator',
    maxTokens: 6000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const greetJs = path.join(tmpDir, 'src', 'greet.js');
      const indexJs = path.join(tmpDir, 'src', 'index.js');
      fs.writeFileSync(greetJs,
        "'use strict';\nfunction greet() { return 'hello'; }\nmodule.exports = { greet };\n");
      fs.writeFileSync(indexJs,
        "'use strict';\n// TODO: wire up modules here\n");
      const taskBody = `## Mission context
Behavioral test. Wire a completed module into an index file.

## Your task
Modify \`${indexJs}\` to:
1. Require \`./greet\` (the greet module)
2. Re-export the \`greet\` function

Success criteria:
- [ ] \`${indexJs}\` contains \`require('./greet')\` or similar
- [ ] \`greet\` is exported from \`${indexJs}\`

## Constraints
Only modify \`${indexJs}\`. Read \`${greetJs}\` to understand its interface.`;
      return buildWorkerDigest(tmpDir, 'integrator', 'item-behavioral-001', [indexJs], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'COMPLETE') {
        assertWorkSection(name, text);
        if (text.includes('greet') || text.includes('require')) {
          ok(`${name}: wiring content (greet/require) present in work output`);
        } else {
          adv(`${name}: expected wiring content not found in response`);
        }
      }
    },
  },

  // 11. doc-writer: document add function → COMPLETE
  {
    name: 'doc-writer',
    expectedCapability: 'orchestrator',
    maxTokens: 6000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'),  { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      const addJs = path.join(tmpDir, 'src', 'add.js');
      const docMd = path.join(tmpDir, 'docs', 'add.md');
      fs.writeFileSync(addJs,
        "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n");
      const taskBody = `## Mission context
Behavioral test. Document a simple add function by reading its implementation.

## Your task
Read \`${addJs}\` and write user-facing documentation to \`${docMd}\`.

Success criteria:
- [ ] \`${docMd}\` exists with a description of the \`add\` function
- [ ] Documentation matches the actual implementation (not aspirational)

## Constraints
Write only to \`${docMd}\`. Read \`${addJs}\` to understand actual behavior.`;
      return buildWorkerDigest(tmpDir, 'doc-writer', 'item-behavioral-001', [docMd], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'COMPLETE') {
        assertWorkSection(name, text, /* advisory */ true);
        if (text.toLowerCase().includes('add')) {
          ok(`${name}: documentation content references the add function`);
        } else {
          adv(`${name}: expected function documentation not found in response`);
        }
      }
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 3: planner-local + cloud agents
  // ─────────────────────────────────────────────────────────────────────────────

  // 12. planner-local: pending item with no deps → VERDICT ready
  {
    name: 'planner-local',
    expectedCapability: 'local-planner',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      const currentMd   = path.join(tmpDir, 'current.md');
      const waveSummary = path.join(tmpDir, 'wave-summary.json');
      const learningsMd = path.join(tmpDir, 'learnings.md');
      const currentContent = [
        '## Outcome',
        'Build a simple Node.js CLI that prints "hello world".',
        '',
        '## Items',
        '',
        '### item-behavioral-001',
        'status: pending',
        'agent: implementer',
        'target_resources: [src/index.js]',
        'depends_on: []',
        'notes: implement main entry point',
      ].join('\n');
      const waveSummaryText = JSON.stringify({ dep_discoveries: [] }, null, 2);
      fs.writeFileSync(currentMd, currentContent);
      fs.writeFileSync(waveSummary, waveSummaryText);
      fs.writeFileSync(learningsMd, '');
      return [
        `current.md: ${currentMd}`,
        'signal: dep_update',
        `wave_summary: ${waveSummary}`,
        'affected_items: [item-behavioral-001]',
        `learnings.md: ${learningsMd}`,
        '',
        'Contents of current.md:',
        '```markdown', currentContent.trim(), '```',
        '',
        'Contents of wave_summary (JSON):',
        '```json', waveSummaryText.trim(), '```',
      ].join('\n');
    },
    validate(name, block) {
      // planner-local uses CYCLE grammar not standard RECUSE/PARTIAL
      if (!['COMPLETE', 'CYCLE', 'ERROR'].includes(block.STATUS)) {
        fail(`${name}: STATUS "${block.STATUS}" not in {COMPLETE, CYCLE, ERROR}`);
        return;
      }
      ok(`${name}: STATUS=${block.STATUS}`);
      if (!block.SUMMARY) fail(`${name}: SUMMARY absent`); else ok(`${name}: SUMMARY present`);
      if (block.STATUS === 'COMPLETE') {
        if (!['ready', 'done'].includes(block.VERDICT)) {
          fail(`${name}: VERDICT "${block.VERDICT}" not in {ready, done}`);
        } else {
          ok(`${name}: VERDICT=${block.VERDICT}`);
        }
        if (block.VERDICT === 'ready' && !block.READY_ITEMS) {
          fail(`${name}: READY_ITEMS absent when VERDICT=ready`);
        } else if (block.VERDICT === 'ready') {
          ok(`${name}: READY_ITEMS=${block.READY_ITEMS}`);
        }
      }
    },
  },

  // 13. implementer-cloud: cloud tier — same task as implementer, skip on 401
  {
    name: 'implementer-cloud',
    expectedCapability: 'deep-coder-cloud',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const helloJs = path.join(tmpDir, 'src', 'hello.js');
      fs.writeFileSync(helloJs,
        "'use strict';\nfunction hello() { return 42; }\nmodule.exports = hello;\n");
      const taskBody = `## Mission context
Behavioral test. Cloud-tier implementer — append marker comment.

## Prior wave context
No prior wave output.

## Your task
Append the comment \`// behavioral-test-marker\` as the final line of \`${helloJs}\`.

Success criteria:
- [ ] \`${helloJs}\` ends with \`// behavioral-test-marker\`
- [ ] File remains syntactically valid JavaScript

## Constraints
Only modify \`${helloJs}\`.`;
      return buildWorkerDigest(tmpDir, 'implementer-cloud', 'item-behavioral-001', [helloJs], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
        assertWorkSection(name, text);
        if (block.LINT_ITERATIONS !== undefined && !/^\d+$/.test(block.LINT_ITERATIONS)) {
          fail(`${name}: LINT_ITERATIONS "${block.LINT_ITERATIONS}" not a non-negative integer`);
        } else if (block.LINT_ITERATIONS !== undefined) {
          ok(`${name}: LINT_ITERATIONS=${block.LINT_ITERATIONS}`);
        }
      }
    },
  },

  // 14. test-writer-cloud: cloud tier — same task as test-writer, skip on 401
  {
    name: 'test-writer-cloud',
    expectedCapability: 'code-analyst-cloud',
    maxTokens: 4000,
    buildMessage(tmpDir) {
      fs.mkdirSync(path.join(tmpDir, 'src'),  { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
      const addJs  = path.join(tmpDir, 'src', 'add.js');
      const testJs = path.join(tmpDir, 'test', 'add.test.js');
      fs.writeFileSync(addJs,
        "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n");
      const taskBody = `## Mission context
Behavioral test. Cloud-tier test writer.

## Implementation to test
Read \`${addJs}\` before writing tests.

## Your task
Write tests for \`add\` into \`${testJs}\`.

Success criteria:
- [ ] \`${testJs}\` has at least one test for \`add(1, 2) === 3\`

## Constraints
Write only to \`${testJs}\`.`;
      return buildWorkerDigest(tmpDir, 'test-writer-cloud', 'item-behavioral-001', [testJs], taskBody);
    },
    validate(name, block, text) {
      if (!validateBase(name, block)) return;
      if (block.STATUS === 'COMPLETE') {
        assertWorkSection(name, text);
      }
    },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  installExitHandlers();

  const { host, port } = resolveProxy();

  process.stdout.write(`Checking proxy at ${host}:${port}… `);
  const alive = await pingProxy(host, port);
  if (!alive) {
    console.log('');
    console.log('agent-contract-behavioral: SKIP — proxy not reachable');
    console.log('  Start with: c-thru --proxy   or set CLAUDE_PROXY_URL / CLAUDE_PROXY_PORT');
    process.exit(0);
  }
  console.log('ok');

  const active = FILTER ? ROSTER.filter(e => FILTER.has(e.name)) : ROSTER;
  console.log(`\nAgent behavioral tests (${active.length} agent${active.length !== 1 ? 's' : ''} — may take several minutes)\n`);

  for (const entry of active) {
    await runTest(host, port, entry);
  }

  if (advisory.length > 0) {
    console.log('\nBehavioral advisory (not gated):');
    for (const a of advisory) console.log(`  adv   ${a}`);
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
