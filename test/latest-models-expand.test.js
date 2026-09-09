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
assert(expandLatestModel('fable', map.latest_models) === 'claude-fable-5-1', 'fable → claude-fable-5-1');
assert(expandLatestModel('opus', map.latest_models) === 'claude-opus-5', 'opus → claude-opus-5');
assert(expandLatestModel('deepseek-flash', map.latest_models) === 'deepseek-v4-flash:0731-cloud', 'deepseek-flash → DeepSeek V4 Flash 0731');
assert(expandLatestModel('qwen', map.latest_models) === 'qwen3.8:27b-mxfp8', 'qwen → Qwen 3.8 27B mxfp8');
assert(expandLatestModel('glm', map.latest_models) === 'glm-5.3:cloud', 'glm → GLM 5.3 cloud');
assert(expandLatestModel('glm-flash', map.latest_models) === 'glm-5.3-flash:cloud', 'glm-flash → GLM 5.3 Flash cloud');
assert(expandLatestModel('coder', map.latest_models) == null, 'coder not expanded');
assert(expandLatestModel('claude-fable-5-1', map.latest_models) == null, 'concrete id not re-expanded');

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
for (const key of ['opus', 'sonnet', 'haiku', 'fable', 'grok', 'deepseek', 'qwen', 'kimi', 'glm', 'glm-flash']) {
  assert(a2c[key] && String(a2c[key]).startsWith('model:'), `a2c[${key}] is model: pin`);
  assert(fs.existsSync(path.join(__dirname, '..', 'agents', `${key}.md`)), `agents/${key}.md exists`);
}

console.log('4a. generated README routing table expands generic brand pins');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const tableBegin = '<!-- BEGIN routing-table';
const tableEnd = '<!-- END routing-table -->';
const begin = readme.indexOf(tableBegin);
const end = readme.indexOf(tableEnd, begin);
assert(begin !== -1 && end !== -1, 'README contains the generated routing-table region');
const routingTable = readme.slice(begin, end);
for (const { agent, model, endpoint } of [
  { agent: 'qwen', model: 'qwen3.8:27b-mxfp8', endpoint: 'ollama_local' },
  { agent: 'kimi', model: 'kimi-k3:cloud', endpoint: 'ollama_cloud' },
  { agent: 'glm', model: 'glm-5.3:cloud', endpoint: 'ollama_cloud' },
  { agent: 'glm-flash', model: 'glm-5.3-flash:cloud', endpoint: 'ollama_cloud' },
  { agent: 'grok', model: 'grok-4.6', endpoint: 'xai' },
]) {
  const row = routingTable.split('\n').find((line) => line.startsWith(`| \`${agent}\` `));
  const expected = `| \`${agent}\` &nbsp;⚠ | \`model:${agent}\` | \`${model}\` | \`${model}\` | \`${model}\` | \`${endpoint}\` |`;
  assert(row === expected, `README ${agent} row expands to ${model} through ${endpoint}`);
}

console.log('4b. Qwen tier and modality guardrails');
for (const [name, profile] of Object.entries(map.llm_profiles || {})) {
  const local16 = profile?.['best-local-oss']?.['16gb'];
  assert(local16 !== 'qwen3.8:27b-mlx' && local16 !== 'qwen3.8:27b-nvfp4' && local16 !== 'qwen3.8:27b-mxfp8',
    `${name} 16gb does not select a Qwen 3.8 27B artifact`);
}
assert(map.vision_capable_models?.['qwen3.8:27b-mlx'] === true,
  'Qwen 3.8 MLX is declared vision-capable');
assert(map.vision_capable_models?.['qwen3.8:27b-nvfp4'] === true,
  'Qwen 3.8 NVFP4 alias is declared vision-capable');
assert(map.vision_capable_models?.['qwen3.8:27b-mxfp8'] === true,
  'Qwen 3.8 mxfp8 is declared vision-capable');
assert(map.vision_capable_models?.['glm-5.3-flash:cloud'] === true,
  'GLM 5.3 Flash is declared vision-capable');
assert(map.context_windows?.['qwen3.8:27b-mlx'] === 262144,
  'Qwen 3.8 MLX records its 256K context limit');
assert(map.context_windows?.['qwen3.8:27b-mxfp8'] === 262144,
  'Qwen 3.8 mxfp8 records its 256K context limit');

console.log('4c. routing preferences stay structural, not one-time edits');
const profileStrings = [];
function collectProfileStrings(value) {
  if (typeof value === 'string') {
    profileStrings.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) collectProfileStrings(child);
}
collectProfileStrings(map.llm_profiles || {});
const hardCodedClaude = [...new Set(profileStrings.filter(value =>
  /^claude-(?:opus|sonnet)-/i.test(value)))];
assert(hardCodedClaude.length === 0,
  `role profiles use moving opus/sonnet aliases (direct pins: ${hardCodedClaude.join(', ') || 'none'})`);
const defaultGemini = [...new Set(profileStrings.filter(value => /gemini/i.test(value)))];
assert(defaultGemini.length === 0,
  `Gemini remains explicit-only, not a role default (profile values: ${defaultGemini.join(', ') || 'none'})`);
const coderCloudOss = map.llm_profiles?.coder?.['best-cloud-oss'];
const coderCloudOssModels = typeof coderCloudOss === 'string'
  ? [coderCloudOss]
  : Object.values(coderCloudOss || {});
assert(coderCloudOssModels.length > 0 && coderCloudOssModels.every(value => value === 'kimi-k3:cloud'),
  `coder best-cloud-oss stays on Kimi K3 at every tier (got: ${coderCloudOssModels.join(', ') || 'none'})`);

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
  const out = explainOut(['--model', 'deepseek-flash', '--mode', 'best-cloud-oss', '--tier', '128gb']);
  assert(/deepseek-v4-flash:0731-cloud/.test(out), 'deepseek-flash resolves to the 0731 model');
  assert(/ollama_cloud/.test(out), 'deepseek-flash resolves through ollama_cloud');
}
{
  const out = explainOut(['--model', 'qwen', '--mode', 'best-local-oss', '--tier', '128gb']);
  assert(/qwen3\.8:27b-mxfp8/.test(out), 'qwen resolves to the installed Qwen 3.8 mxfp8 tag');
  assert(/ollama_local/.test(out), 'qwen resolves through ollama_local');
}
{
  const out = explainOut(['--model', 'fable', '--mode', 'best-cloud-oss']);
  assert(/claude-fable-5-1/.test(out) && /anthropic/.test(out), 'fable → claude-fable-5-1 @ anthropic');
  assert(!/served_by\s+deepseek/i.test(out), 'fable not deepseek');
}
{
  const out = explainOut(['--model', 'tester', '--mode', 'best-cloud-oss', '--tier', '128gb']);
  assert(/capability|llm_profiles|served_by/i.test(out), 'tester logical model resolves');
}
{
  const out = explainOut(['--capability', 'coder', '--mode', 'best-cloud', '--tier', '64gb']);
  const final = out.split('Final routing')[1] || '';
  assert(/latest_models\s+sonnet\s+→\s+claude-sonnet-5/.test(out),
    'capability explain shows the Sonnet latest expansion');
  assert(/served_by\s+claude-sonnet-5/.test(final),
    'capability explain reports concrete current Sonnet, not the logical alias');
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
  const out = explainOut(['--agent', 'glm-flash']);
  const final = out.split('Final routing')[1] || '';
  assert(/served_by\s+glm-5\.3-flash:cloud/.test(final),
    'agent glm-flash served_by is glm-5.3-flash:cloud');
  assert(/endpoint\s+ollama_cloud/.test(final),
    'agent glm-flash endpoint is ollama_cloud');
}
{
  const out = explainOut(['--agent', 'qwen']);
  const final = out.split('Final routing')[1] || '';
  assert(/served_by\s+qwen3\.8:27b-mxfp8/.test(final),
    'agent qwen served_by is local qwen3.8:27b-mxfp8');
  assert(/endpoint\s+ollama_local/.test(final),
    'agent qwen endpoint is ollama_local');
}
console.log('\nAll latest-models-expand checks passed');
process.exit(0);
