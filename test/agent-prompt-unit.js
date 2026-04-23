#!/usr/bin/env node
'use strict';
/**
 * Agent Prompt Unit Test
 * Runs a single agent prompt through c-thru proxy to a real model.
 * Focused on extracting "real learnings" and findings.
 *
 * Usage: CLAUDE_BIN="node test/agent-prompt-unit.js <agent-name>" c-thru --model <model>
 */

const fs   = require('fs');
const http = require('http');
const path = require('path');

const args = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    if (!arg.includes('=') && i + 1 < process.argv.length && !process.argv[i+1].startsWith('--')) {
      i++; // skip the value
    }
    continue;
  }
  args.push(arg);
}
const agentName = args[0];
if (!agentName) {
  console.error('Usage: node test/agent-prompt-unit.js <agent-name>');
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const CONTRACT_FILE = path.join(REPO_ROOT, 'shared', '_worker-contract.md');

// Helper to strip frontmatter
function readSystemPrompt(name) {
  const p = path.join(AGENTS_DIR, `${name}.md`);
  if (!fs.existsSync(p)) {
    console.error(`Agent file not found: ${p}`);
    process.exit(1);
  }
  const content = fs.readFileSync(p, 'utf8');
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

// Helper to strip post-work linting from contract
function stripContract(text) {
  return text.replace(/---\n\n## Post-work linting[\s\S]*$/, '').trim();
}

const WORKER_CONTRACT = fs.existsSync(CONTRACT_FILE) 
  ? stripContract(fs.readFileSync(CONTRACT_FILE, 'utf8'))
  : '';

// Default sample inputs per agent
const SAMPLE_INPUTS = {
  'implementer': `---
agent: implementer
item_id: item-001
wave: "001"
target_resources: [src/utils.js]
---

## Mission context
Add a function \`isPalindrome(str)\` to src/utils.js.
It should be case-insensitive and ignore non-alphanumeric characters.

## Your task
Implement \`isPalindrome\` in src/utils.js.

---\n\n${WORKER_CONTRACT}`,

  'test-writer': `---
agent: test-writer
item_id: item-002
wave: "001"
target_resources: [src/utils.test.js]
---

## Mission context
Write unit tests for \`isPalindrome(str)\` which was just implemented in src/utils.js.

Implementation in src/utils.js:
\`\`\`javascript
export function isPalindrome(str) {
  if (typeof str !== 'string') return false;
  const clean = str.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean === clean.split('').reverse().join('');
}
\`\`\`

## Your task
Write comprehensive unit tests in src/utils.test.js.

---\n\n${WORKER_CONTRACT}`,

  'discovery-advisor': `intent: Add a new API endpoint for user profile updates.
recon_path: recon.md

Contents of recon.md:
# Reconnaissance summary
- src/api/auth.js exists
- src/models/User.js exists
- No existing profile update logic found.
- Project uses Express and Mongoose.`,

  'explorer': `gap_question: How are user models structured in src/models/User.js?
output_path: discovery/user-model.md

File list:
- src/models/User.js
- src/models/Post.js`
};

const userMessage = SAMPLE_INPUTS[agentName] || `---
agent: ${agentName}
item_id: test-item
---

## Your task
Perform your standard role for a generic task: "Update the project README with current project status".

---\n\n${WORKER_CONTRACT}`;

const PROXY_HOST = '127.0.0.1';
let PROXY_PORT = Number(process.env.CLAUDE_PROXY_PORT);
if (!PROXY_PORT && process.env.ANTHROPIC_BASE_URL) {
  try {
    const u = new URL(process.env.ANTHROPIC_BASE_URL);
    PROXY_PORT = Number(u.port);
  } catch {}
}
if (!PROXY_PORT) PROXY_PORT = 9001;

async function postMessages(name, system, user) {
  const body = {
    model: name,
    max_tokens: 4000,
    stream: false,
    system: `/no_think\n\n${system}`,
    messages: [{ role: 'user', content: user + '\n\nIMPORTANT: You MUST conclude your response with the required STATUS block.' }],
  };
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY || 'unit-test'}`,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${bodyText}`));
            return;
          }
          let json = null;
          try { json = JSON.parse(bodyText); } catch {}
          const text = json && Array.isArray(json.content)
            ? json.content.map(c => c.text || '').join('')
            : bodyText;
          resolve(text);
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function parseLearnings(text) {
  const match = text.match(/### Learnings\s*([\s\S]*?)(?:\n\n##|$)/);
  return match ? match[1].trim() : 'No learnings found.';
}

function parseFindings(text) {
  const match = text.match(/## Findings \(jsonl\)\s*```jsonl\s*([\s\S]*?)```/);
  return match ? match[1].trim() : 'No findings found.';
}

function parseStatus(text) {
  const match = text.match(/STATUS:\s*(\w+)/);
  return match ? match[1] : 'UNKNOWN';
}

async function run() {
  console.log(`\n=== Unit Testing Agent: ${agentName} ===`);
  const system = readSystemPrompt(agentName);
  
  console.log(`Sending prompt to proxy at ${PROXY_HOST}:${PROXY_PORT}...`);
  try {
    const resp = await postMessages(agentName, system, userMessage);
    
    console.log('\n--- REAL LEARNINGS ---');
    console.log(parseLearnings(resp));
    
    console.log('\n--- FINDINGS ---');
    console.log(parseFindings(resp));
    
    console.log('\n--- STATUS ---');
    console.log(parseStatus(resp));
    
    if (process.env.SHOW_FULL_RESPONSE) {
      console.log('\n--- FULL RESPONSE ---');
      console.log(resp);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

run();
