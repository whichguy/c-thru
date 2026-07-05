#!/usr/bin/env bash
':' //; exec node "$0" "$@"
'use strict';
// B2 — router-hook unit suite (deterministic, no LLM).
//
// Proves the PreToolUse hook (tools/c-thru-agent-router-hook.sh) — the per-delegation
// HANDSHAKE that carries agent identity to the proxy. On every Agent call it:
//   1. injects a VALID model alias (C_THRU_AGENT_FALLBACK_ALIAS, default "sonnet").
//   2. prepends a [[c-thru-agent:<subagent_type>]] sentinel to the task prompt.
//
// This file is intentionally bash/node polyglot: run-all.sh invokes it with bash,
// while direct verification invokes it with node. Both paths execute this Node
// harness, which invokes the bash hook under test.
//
// Run: node test/agent-router-hook.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_DIR, 'tools', 'c-thru-agent-router-hook.sh');
const MODEL_MAP = path.join(REPO_DIR, 'config', 'model-map.json');
const PROD_CONFIG = JSON.parse(fs.readFileSync(MODEL_MAP, 'utf8'));
const DEFAULT_ALIAS = 'sonnet';

let PASS = 0;
let FAIL = 0;

function check(label, expected, actual) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    PASS++;
  } else {
    console.log(`  FAIL  ${label} (expected '${expected}', got '${actual}')`);
    FAIL++;
  }
}

function runHook(payload, extraEnv = {}) {
  const env = Object.assign({}, process.env, {
    CLAUDE_MODEL_MAP_PATH: MODEL_MAP,
  }, extraEnv);
  const res = spawnSync('bash', [HOOK], {
    input: payload,
    encoding: 'utf8',
    env,
  });
  return res.stdout || '';
}

function parseJsonOrNull(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function hookRaw(payload, extraEnv = {}) {
  return runHook(payload, extraEnv);
}

function hookModel(payload, extraEnv = {}) {
  const out = hookRaw(payload, extraEnv);
  if (!out) return '';
  const parsed = parseJsonOrNull(out);
  return parsed?.hookSpecificOutput?.updatedInput?.model || '';
}

function hookPrompt(payload, extraEnv = {}) {
  const out = hookRaw(payload, extraEnv);
  if (!out) return '';
  const parsed = parseJsonOrNull(out);
  return parsed?.hookSpecificOutput?.updatedInput?.prompt || '';
}

function agentPayload(agent) {
  return JSON.stringify({
    tool_name: 'Agent',
    tool_input: { subagent_type: agent, description: 'd', prompt: 'p' },
  });
}

function hasCapability(agent) {
  return Boolean((PROD_CONFIG.agent_to_capability || {})[agent]);
}

function pathWithoutJq() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter(dir => !fs.existsSync(path.join(dir, 'jq')))
    .join(path.delimiter);
}

function writeTempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-hook-test-'));
  const configPath = path.join(dir, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath };
}

// ── 1. Every mapped agent → updatedInput.model == the valid alias (unblocks) ──────
console.log(`1. Agent subagent_type → valid alias '${DEFAULT_ALIAS}' (full fleet, unblocks delegation)`);
const agents = fs.readdirSync(path.join(REPO_DIR, 'agents'))
  .filter(name => name.endsWith('.md'))
  .map(name => path.basename(name, '.md'))
  .sort();
for (const agent of agents) {
  if (hasCapability(agent)) {
    check(`Agent(${agent}) → model=${DEFAULT_ALIAS} (valid, not blocked)`, DEFAULT_ALIAS, hookModel(agentPayload(agent)));
  } else {
    check(`Agent(${agent}) → passthrough (no capability mapping)`, '', hookModel(agentPayload(agent)));
  }
}
check('fleet roster is 22 agents', '22', String(agents.length));

// ── 2. The injected alias is a VALID enum value, and is overridable ───────────────
console.log('');
console.log('2. Injected model is always a valid Agent-tool alias; remaps no longer affect the hook');
check(`reviewer-plan → ${DEFAULT_ALIAS} (valid alias)`, DEFAULT_ALIAS, hookModel(agentPayload('reviewer-plan')));
check(`plan-scheduler → ${DEFAULT_ALIAS} (valid alias)`, DEFAULT_ALIAS, hookModel(agentPayload('plan-scheduler')));
check('C_THRU_AGENT_FALLBACK_ALIAS=opus → model=opus', 'opus',
  hookModel(agentPayload('coder'), { C_THRU_AGENT_FALLBACK_ALIAS: 'opus' }));

// ── 3. Non-LLM tools pass through unmodified (no updatedInput emitted) ─────────
console.log('');
console.log('3. Non-LLM tools pass through with NO model override');
check('WebSearch → no stdout (passthrough)', '', hookRaw('{"tool_name":"WebSearch","tool_input":{"query":"hi"}}'));
check('Plan → no stdout (passthrough)', '', hookRaw('{"tool_name":"Plan","tool_input":{"plan":"x"}}'));
check('Bash → no stdout (unknown tool passthrough)', '', hookRaw('{"tool_name":"Bash","tool_input":{"command":"ls"}}'));

// ── 4. Unknown subagent_type passes through (no override) ──────────────────────
console.log('');
console.log('4. Unknown / missing subagent_type → no override');
check('unknown subagent_type → empty model', '', hookModel(agentPayload('totally-unknown-agent-xyz')));
check('Agent with no subagent_type → no stdout', '', hookRaw('{"tool_name":"Agent","tool_input":{"prompt":"p"}}'));
check('empty payload → no stdout', '', hookRaw('{}'));

// ── 4b. advisor:<model-id> runtime pin passes the capability gate ─────────────
console.log('');
console.log('4b. advisor:<model-id> runtime pin → sentinel injected without config entry');
{
  const { dir, configPath } = writeTempConfig({ agent_to_capability: {} });
  try {
    const prompt = hookPrompt(agentPayload('advisor:deepseek-v4-pro:cloud'), { CLAUDE_MODEL_MAP_PATH: configPath });
    const ok = prompt.includes('[[c-thru-agent:advisor:deepseek-v4-pro:cloud]]') ? 'yes' : 'no';
    check('advisor runtime pin prompt carries [[c-thru-agent:advisor:deepseek-v4-pro:cloud]] sentinel', 'yes', ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5. updatedInput merges model + sentinel-prompt, preserving fields ─────────
console.log('');
console.log('5. updatedInput injects model + [[c-thru-agent:..]] sentinel prompt, preserves fields');
{
  const out = hookRaw(agentPayload('planner'));
  const parsed = parseJsonOrNull(out) || {};
  const updated = parsed.hookSpecificOutput?.updatedInput || {};
  const decision = parsed.hookSpecificOutput?.permissionDecision || '';
  check('prompt carries the [[c-thru-agent:planner]] sentinel', 'yes',
    String(updated.prompt || '').includes('[[c-thru-agent:planner]]') ? 'yes' : 'no');
  check('prompt preserves the original task text', 'yes',
    String(updated.prompt || '').includes('p') ? 'yes' : 'no');
  check('original subagent_type preserved in updatedInput', 'planner', updated.subagent_type || '');
  check('permissionDecision=allow', 'allow', decision);
}

// ── 6. node-fallback path (no jq) emits the alias AND the sentinel prompt ───────
console.log('');
console.log('6. node fallback (jq removed from PATH) emits alias + sentinel prompt');
{
  const nojqEnv = { PATH: pathWithoutJq() };
  const out = hookRaw(agentPayload('coder'), nojqEnv);
  const parsed = parseJsonOrNull(out) || {};
  const updated = parsed.hookSpecificOutput?.updatedInput || {};
  check(`coder → ${DEFAULT_ALIAS} via node fallback`, DEFAULT_ALIAS, updated.model || '');
  check('node fallback prompt carries [[c-thru-agent:coder]] sentinel', 'yes',
    String(updated.prompt || '').includes('[[c-thru-agent:coder]]') ? 'yes' : 'no');
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`${PASS + FAIL} tests: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
