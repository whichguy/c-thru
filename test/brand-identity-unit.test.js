#!/usr/bin/env node
'use strict';
// Hermetic pins for brand identity templates + score/matcher helpers.

const fs = require('fs');
const path = require('path');
const { assert, assertEq, summary } = require('./helpers');

const REPO = path.join(__dirname, '..');
const score = require(path.join(REPO, 'tools', 'brand-identity-score.js'));
const { pinMatches, scoreIdentity } = score;

console.log('brand-identity unit tests\n');

console.log('1. Generated agent bodies: binding identity');
{
  const deepseek = fs.readFileSync(path.join(REPO, 'agents', 'deepseek.md'), 'utf8');
  const opus = fs.readFileSync(path.join(REPO, 'agents', 'opus.md'), 'utf8');
  const gptOss = fs.readFileSync(path.join(REPO, 'agents', 'gpt-oss.md'), 'utf8');
  assert(/Identity \(binding/.test(deepseek), 'deepseek has binding identity');
  assert(/Never answer "I am Claude"/.test(deepseek), 'deepseek anti-Claude');
  assert(/Identify as \*\*DeepSeek\*\*/.test(deepseek), 'deepseek claim');
  assert(/Identify as \*\*Claude/.test(opus), 'opus Claude claim');
  assert(!/Never answer "I am Claude"/.test(opus), 'opus is allowed Claude');
  assert(/ChatGPT/.test(gptOss) && /GPT-OSS/.test(gptOss), 'gpt-oss forbids ChatGPT product claim');
}

console.log('2. pinMatches requires served_by (not request model alone)');
{
  assert(
    !pinMatches('deepseek-v4-pro:cloud', { served_by: 'glm-5.2:cloud', model: 'glm-5.2:cloud' }),
    'cloud alone must not match deepseek pin',
  );
  assert(
    !pinMatches('grok-4.5', { served_by: 'glm-5.2:cloud', model: 'grok' }),
    'request model=grok with glm served_by must NOT count as invoke_ok',
  );
  assert(
    pinMatches('deepseek-v4-pro:cloud', {
      served_by: 'deepseek-v4-pro:cloud',
      model: 'deepseek',
    }),
    'full pin match',
  );
  assert(
    pinMatches('qwen3.6:35b', { served_by: 'qwen3.6:35b', model: 'qwen' }),
    'qwen pin',
  );
  assert(
    pinMatches('kimi-k3:cloud', { served_by: 'kimi-k3:cloud', model: 'kimi' }),
    'kimi pin',
  );
  assert(
    pinMatches('gemini-pro', { served_by: 'gemini-pro-latest', model: 'gemini-pro' }),
    'gemini-pro pin matches gemini-pro-latest served_by',
  );
}

console.log('3. scoreIdentity table');
{
  let r = scoreIdentity({
    agent: 'deepseek',
    family: 'deepseek',
    leafText: "I'm Claude Sonnet 5, made by Anthropic.",
  });
  assert(!r.identity_ok && r.claude_claim, 'deepseek+Claude → fail');

  r = scoreIdentity({
    agent: 'deepseek',
    family: 'deepseek',
    leafText: 'I am DeepSeek Pro, made by DeepSeek.',
  });
  assert(r.identity_ok && r.has_positive, 'deepseek correct → pass');

  r = scoreIdentity({ agent: 'deepseek', family: 'deepseek', leafText: '' });
  assert(!r.identity_ok, 'empty → fail');

  r = scoreIdentity({
    agent: 'opus',
    family: 'anthropic-claude',
    leafText: 'I am Claude, built by Anthropic.',
  });
  assert(r.identity_ok, 'claude family ok');

  r = scoreIdentity({
    agent: 'gpt-oss',
    family: 'gpt-oss',
    leafText: "I'm ChatGPT, created by OpenAI.",
  });
  assert(r.identity_ok && r.advisory, 'gpt-oss ChatGPT claim advisory pass');
}

const failed = summary();
process.exit(failed > 0 ? 1 : 0);
