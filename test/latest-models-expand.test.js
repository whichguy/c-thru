#!/usr/bin/env node
'use strict';
// latest_models expansion + brand compact prompts
const path = require('path');
const fs = require('fs');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('  PASS', m); };

const { expandLatestModel, resolveModelRoute } = require('../tools/model-map-resolve.js');
const compact = require('../tools/brand-agent-compact.js');

const mapPath = path.join(__dirname, '..', 'config', 'model-map.json');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

console.log('1. expandLatestModel');
assert(expandLatestModel('fable', map.latest_models) === 'claude-fable-5', 'fable → claude-fable-5');
assert(expandLatestModel('opus', map.latest_models) === 'claude-opus-5', 'opus → claude-opus-5');
assert(expandLatestModel('glm', map.latest_models) === 'glm-5.3:cloud', 'glm → GLM 5.3 cloud');
assert(expandLatestModel('coder', map.latest_models) == null, 'coder not expanded');
assert(expandLatestModel('claude-fable-5', map.latest_models) == null, 'concrete id not re-expanded');

console.log('2. resolveModelRoute under best-cloud-oss (no DeepSeek under fable/opus)');
for (const mode of ['best-cloud', 'best-cloud-oss', 'best-local-oss']) {
  for (const sh of ['fable', 'opus', 'sonnet', 'haiku']) {
    const r = resolveModelRoute(sh, {
      routes: map.model_routes,
      endpoints: map.endpoints,
      mode,
      latest_models: map.latest_models,
    });
    assert(r && r.endpointId === 'anthropic', `${sh} @ ${mode} → anthropic (got ${r && r.endpointId})`);
    assert(r.servedBy && String(r.servedBy).startsWith('claude-'), `${sh} @ ${mode} servedBy claude-* (got ${r.servedBy})`);
    assert(!/deepseek|kimi|glm|qwen/i.test(r.servedBy || ''), `${sh} @ ${mode} not OSS substitute`);
  }
}

console.log('3. compact brand prompts');
const fableP = compact.compactBrandPrompt({ id: 'fable', label: 'Claude Fable', family: 'anthropic-claude' });
assert(fableP.length <= compact.MAX_PROMPT_BYTES, `fable compact ≤ ${compact.MAX_PROMPT_BYTES} (got ${fableP.length})`);
assert(/Claude Fable|Anthropic/i.test(fableP), 'fable mentions Claude Fable/Anthropic');
const grokP = compact.compactBrandPrompt({ id: 'grok', label: 'Grok (xAI)', family: 'xai' });
assert(grokP.length <= compact.MAX_PROMPT_BYTES, `grok compact ≤ ${compact.MAX_PROMPT_BYTES}`);
assert(/Grok|xAI/i.test(grokP) && /not claim to be Claude/i.test(grokP), 'grok anti-Claude');
assert(compact.isGeneratedBrandBody(fs.readFileSync(path.join(__dirname, '..', 'agents/fable.md'), 'utf8')), 'fable.md is brand body');
assert(!compact.isGeneratedBrandBody('# Agent: coder\n\nWrite code.'), 'coder not brand body');

console.log('4. latest_models keys have a2c brand pins');
const a2c = map.agent_to_capability || {};
for (const key of Object.keys(map.latest_models || {})) {
  // optional: not every latest key must be agent (e.g. if catalog incomplete)
  // require agents for claude + major brands
}
for (const key of ['opus', 'sonnet', 'haiku', 'fable', 'grok', 'deepseek', 'glm']) {
  assert(a2c[key] && String(a2c[key]).startsWith('model:'), `a2c[${key}] is model: pin`);
  assert(fs.existsSync(path.join(__dirname, '..', 'agents', `${key}.md`)), `agents/${key}.md exists`);
}


console.log('4a. generated README routing table expands GLM family pin');
{
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const tableBegin = '<!-- BEGIN routing-table';
  const tableEnd = '<!-- END routing-table -->';
  const begin = readme.indexOf(tableBegin);
  const end = readme.indexOf(tableEnd, begin);
  assert(begin !== -1 && end !== -1, 'README contains the generated routing-table region');
  const routingTable = readme.slice(begin, end);
  const row = routingTable.split('\n').find((line) => line.startsWith('| `glm` '));
  const expected = '| `glm` &nbsp;⚠ | `model:glm` | `glm-5.3:cloud` | `glm-5.3:cloud` | `glm-5.3:cloud` | `ollama_cloud` |';
  assert(row === expected, 'README glm row expands to glm-5.3:cloud through ollama_cloud');
}

console.log('5. explain --model logical names (coder / deepseek / fable)');
const { spawnSync } = require('child_process');
const explain = path.join(__dirname, '..', 'tools', 'c-thru-explain.js');
function explainOut(args) {
  const r = spawnSync(process.execPath, [explain, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MODEL_MAP_PATH: mapPath },
  });
  return (r.stdout || '') + (r.stderr || '');
}
{
  const out = explainOut(['--model', 'coder', '--mode', 'best-cloud-oss', '--tier', '128gb']);
  assert(/capability/i.test(out) || /llm_profiles/i.test(out), 'coder explain shows capability path');
  assert(/served_by/i.test(out), 'coder explain has served_by');
  assert(!/served_by\s+coder\s*$/m.test(out.split('Final')[1] || ''), 'coder final served_by is not literal coder');
}
{
  const out = explainOut(['--model', 'deepseek', '--mode', 'best-cloud-oss']);
  assert(/deepseek-v4-pro:cloud|latest_models/i.test(out), 'deepseek maps to concrete or latest hop');
}
{
  const out = explainOut(['--model', 'fable', '--mode', 'best-cloud-oss']);
  assert(/claude-fable-5/.test(out) && /anthropic/.test(out), 'fable → claude-fable-5 @ anthropic');
  assert(!/served_by\s+deepseek/i.test(out), 'fable not deepseek');
}
{
  const out = explainOut(['--model', 'tester', '--mode', 'best-cloud-oss', '--tier', '128gb']);
  assert(/capability|llm_profiles|served_by/i.test(out), 'tester logical model resolves');
}


{
  const out = explainOut(['--agent', 'glm']);
  const final = out.split('Final routing')[1] || '';
  assert(/served_by\s+glm-5\.3:cloud/.test(final),
    'agent glm served_by is glm-5.3:cloud');
  assert(/endpoint\s+ollama_cloud/.test(final),
    'agent glm endpoint is ollama_cloud');
  assert(!/glm-5\.2:cloud/.test(final),
    'agent glm is not the 5.2 exact-id tag');
}
{
  const out = explainOut(['--agent', 'glm-5-3-cloud']);
  const final = out.split('Final routing')[1] || '';
  assert(/served_by\s+glm-5\.3:cloud/.test(final),
    'agent glm-5-3-cloud served_by is glm-5.3:cloud');
  assert(/endpoint\s+ollama_cloud/.test(final),
    'agent glm-5-3-cloud endpoint is ollama_cloud');
}
{
  const out = explainOut(['--agent', 'glm-5-2-cloud']);
  const final = out.split('Final routing')[1] || '';
  assert(/served_by\s+glm-5\.2:cloud/.test(final),
    'agent glm-5-2-cloud remains pinned to glm-5.2:cloud');
}

console.log('\nAll latest-models-expand checks passed');
process.exit(0);
