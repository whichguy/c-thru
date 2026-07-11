#!/usr/bin/env node
'use strict';
// tools/llm-capabilities-shared.js is shared classify_intent logic required by
// BOTH tools/llm-capabilities-mcp.js and tools/claude-proxy — a bug here
// silently affects two independent call sites. It had zero test coverage
// before this file.
//
// Run: node test/llm-capabilities-shared.test.js

const { assert, assertEq, summary } = require('./helpers');

const {
  resolveCapabilityModel,
  buildClassifyPrompt,
  parseTextResponse,
  tryParseJsonText,
  normalizeClassifyResult,
  classifyIntent,
} = require('../tools/llm-capabilities-shared.js');

console.log('llm-capabilities-shared tests\n');

// ── resolveCapabilityModel ──────────────────────────────────────────────────
console.log('1. resolveCapabilityModel');
{
  const config = {
    llm_capabilities: {
      classify_intent: { model: '  gemma4:e2b  ' },
      default: { model: 'fallback-model' },
    },
  };
  assertEq(resolveCapabilityModel(config, 'classify_intent'), 'gemma4:e2b', 'exact match, trimmed');
  assertEq(resolveCapabilityModel(config, 'some_other_tool'), 'fallback-model', 'falls back to .default when tool has no entry');

  let threw = false;
  try { resolveCapabilityModel({ llm_capabilities: {} }, 'classify_intent'); } catch (e) { threw = /No llm_capabilities model configured/.test(e.message); }
  assert(threw, 'throws when neither the tool nor .default has an entry');

  threw = false;
  try { resolveCapabilityModel({ llm_capabilities: { classify_intent: { model: '   ' } } }, 'classify_intent'); } catch (e) { threw = /No llm_capabilities model configured/.test(e.message); }
  assert(threw, 'throws when the configured model is whitespace-only');

  threw = false;
  try { resolveCapabilityModel({ llm_capabilities: { classify_intent: {} } }, 'classify_intent'); } catch (e) { threw = /No llm_capabilities model configured/.test(e.message); }
  assert(threw, 'throws when the entry has no .model field at all');

  threw = false;
  try { resolveCapabilityModel({}, 'classify_intent'); } catch (e) { threw = /No llm_capabilities model configured/.test(e.message); }
  assert(threw, 'throws cleanly (not a TypeError) when config has no llm_capabilities key at all');
}

// ── buildClassifyPrompt ─────────────────────────────────────────────────────
console.log('\n2. buildClassifyPrompt');
{
  const { system, user } = buildClassifyPrompt('fix the bug', 'gemma4:e2b');
  assert(system.includes('"gemma4:e2b"'), 'system prompt names the requested model');
  assert(system.includes('classify_intent'), 'system prompt names the tool being executed');
  assert(system.trim().startsWith('You are executing'), 'system prompt has the expected opening line');
  assertEq(user, 'Prompt:\nfix the bug', 'user turn wraps the raw prompt verbatim');
}

// ── parseTextResponse ────────────────────────────────────────────────────────
console.log('\n3. parseTextResponse');
{
  assertEq(parseTextResponse({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }), 'hello\nworld', 'joins multiple text blocks with newlines');
  assertEq(parseTextResponse({ content: [{ type: 'tool_use', input: {} }, { type: 'text', text: '  padded  ' }] }), 'padded', 'ignores non-text blocks and trims the result');
  assertEq(parseTextResponse({ content: [] }), '', 'empty content array yields empty string');
  assertEq(parseTextResponse({}), '', 'missing content field yields empty string, no crash');
  assertEq(parseTextResponse(null), '', 'null body yields empty string, no crash');
}

// ── tryParseJsonText — all four kinds ────────────────────────────────────────
console.log('\n4. tryParseJsonText');
{
  const strict = tryParseJsonText('{"result":"a","confidence":80}');
  assertEq(strict.kind, 'strict_json', 'plain JSON parses as strict_json');
  assertEq(strict.parsed.result, 'a', 'strict_json: fields are parsed correctly');

  const fenced = tryParseJsonText('Here is the answer:\n```json\n{"result":"b"}\n```\nThanks.');
  assertEq(fenced.kind, 'fenced_json', 'fenced ```json block parses as fenced_json');
  assertEq(fenced.parsed.result, 'b', 'fenced_json: fields are parsed correctly');

  const embedded = tryParseJsonText('Sure, my answer is {"result":"c"} — hope that helps!');
  assertEq(embedded.kind, 'embedded_json', 'brace-scanned prose parses as embedded_json');
  assertEq(embedded.parsed.result, 'c', 'embedded_json: fields are parsed correctly');

  const unparsed = tryParseJsonText('I cannot help with that, sorry.');
  assertEq(unparsed.kind, 'unparsed_text', 'plain prose with no braces falls through to unparsed_text');
  assertEq(unparsed.parsed, null, 'unparsed_text: parsed is null');

  const empty = tryParseJsonText('   ');
  assertEq(empty.kind, 'empty', 'whitespace-only text is classified as empty');

  const notString = tryParseJsonText(undefined);
  assertEq(notString.kind, 'not_string', 'non-string input is classified as not_string, no crash');

  const brokenFence = tryParseJsonText('```json\n{not valid json\n```');
  assertEq(brokenFence.kind, 'unparsed_text', 'malformed content inside a fence falls through to unparsed_text (no crash)');
}

// ── normalizeClassifyResult ──────────────────────────────────────────────────
console.log('\n5. normalizeClassifyResult');
{
  const full = normalizeClassifyResult({
    result: 'route-to-coder',
    confidence: 87,
    recuse_reason: null,
    dynamic_hints: ['use coder next'],
    recommended_tool: 'coder',
    clarification_questions: ['which file?'],
  }, 'raw fallback text');
  assertEq(full.result, 'route-to-coder', 'well-formed result: .result passes through');
  assertEq(full.confidence, 87, 'well-formed result: .confidence passes through');
  assertEq(full.recommended_tool, 'coder', 'well-formed result: .recommended_tool passes through');
  assertEq(JSON.stringify(full.dynamic_hints), JSON.stringify(['use coder next']), 'well-formed result: .dynamic_hints array passes through');
  assertEq(JSON.stringify(full.clarification_questions), JSON.stringify(['which file?']), 'well-formed result: .clarification_questions array passes through');

  const empty = normalizeClassifyResult(null, 'raw fallback text');
  assertEq(empty.result, 'raw fallback text', 'null parsed input: .result falls back to rawText');
  assertEq(empty.confidence, 0, 'null parsed input: .confidence defaults to 0');
  assertEq(empty.recuse_reason, null, 'null parsed input: .recuse_reason defaults to null');
  assertEq(JSON.stringify(empty.dynamic_hints), '[]', 'null parsed input: .dynamic_hints defaults to []');
  assertEq(empty.recommended_tool, null, 'null parsed input: .recommended_tool defaults to null');
  assertEq(JSON.stringify(empty.clarification_questions), '[]', 'null parsed input: .clarification_questions defaults to []');

  const clampedHigh = normalizeClassifyResult({ confidence: 150 }, '');
  assertEq(clampedHigh.confidence, 100, 'confidence above 100 is clamped to 100');

  const clampedLow = normalizeClassifyResult({ confidence: -20 }, '');
  assertEq(clampedLow.confidence, 0, 'confidence below 0 is clamped to 0');

  const nonIntConfidence = normalizeClassifyResult({ confidence: 42.5 }, '');
  assertEq(nonIntConfidence.confidence, 0, 'non-integer confidence is coerced to 0 (Number.isInteger check)');

  const coercedHints = normalizeClassifyResult({ dynamic_hints: [1, true, 'x'] }, '');
  assertEq(JSON.stringify(coercedHints.dynamic_hints), JSON.stringify(['1', 'true', 'x']), 'dynamic_hints array entries are coerced to strings');
}

// ── classifyIntent — full pipeline with a stubbed transport ─────────────────
console.log('\n6. classifyIntent (end-to-end, stubbed postToMessages)');
{
  const config = { llm_capabilities: { classify_intent: { model: 'gemma4:e2b' } } };
  let capturedPayload = null;
  const stubPostToMessages = async payload => {
    capturedPayload = payload;
    return {
      content: [{ type: 'text', text: '```json\n{"result":"route-to-coder","confidence":91,"recommended_tool":"coder","dynamic_hints":["proceed"],"clarification_questions":[]}\n```' }],
    };
  };

  classifyIntent('please fix the login bug', config, stubPostToMessages).then(out => {
    assertEq(capturedPayload.model, 'gemma4:e2b', 'classifyIntent resolves the configured model and passes it to postToMessages');
    assertEq(capturedPayload.stream, false, 'classifyIntent requests a non-streaming call');
    assert(capturedPayload.messages[0].content.includes('please fix the login bug'), 'classifyIntent forwards the raw prompt in the user turn');
    assertEq(out.result, 'route-to-coder', 'end-to-end: fenced-JSON response is parsed and normalized correctly');
    assertEq(out.confidence, 91, 'end-to-end: confidence survives the full pipeline');
    assertEq(out.recommended_tool, 'coder', 'end-to-end: recommended_tool survives the full pipeline');

    const failed = summary();
    process.exit(failed ? 1 : 0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
