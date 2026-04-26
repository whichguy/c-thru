#!/usr/bin/env node
'use strict';
// Unit + integration tests for tools/compile-prompts.js
// Tests every happy path, fallback, and error condition.
// Run: node test/compile-prompts.test.js

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { parseFrontmatter, serializeFrontmatter, compilePrompt } =
  require('../tools/compile-prompts.js');

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++; }
  else       { console.error(`  FAIL  ${msg}`); failed++; }
}

// Temp directory that cleans up after fn returns
function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-prompts-test-'));
  try { return fn(dir); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// Write source, compile, return { prod, debug } content strings
function compile(content, basename = 'myagent') {
  return withTmpDir(tmp => {
    const srcDir  = path.join(tmp, 'src');
    const distDir = path.join(tmp, 'dist');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(srcDir, `${basename}.md`), content);
    compilePrompt(`${basename}.md`, srcDir, distDir);
    return {
      prod:  fs.readFileSync(path.join(distDir, `${basename}.md`),       'utf8'),
      debug: fs.readFileSync(path.join(distDir, `${basename}-debug.md`), 'utf8'),
    };
  });
}

// Extract a frontmatter field value from compiled output
function fmField(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// ── 1. parseFrontmatter ───────────────────────────────────────────────────────
console.log('1. parseFrontmatter — pure function');

{
  // 1. Well-formed frontmatter
  const src = '---\nname: foo\nmodel: foo\ntier_budget: 500\n---\n\n# Body\n\nContent here.\n';
  const { meta, body } = parseFrontmatter(src);
  assert(meta.name        === 'foo',   'well-formed: name extracted');
  assert(meta.model       === 'foo',   'well-formed: model extracted');
  assert(meta.tier_budget === '500',   'well-formed: tier_budget extracted');
  assert(body.includes('# Body'),      'well-formed: body starts after closing ---');
  assert(!body.includes('name: foo'),  'well-formed: frontmatter not leaked into body');
}

{
  // 2. No frontmatter (file starts with #)
  const src = '# Title\n\nBody content.\n';
  const { meta, body } = parseFrontmatter(src);
  assert(Object.keys(meta).length === 0, 'no-frontmatter: meta is empty');
  assert(body === src,                   'no-frontmatter: body equals full input');
}

{
  // 3. Frontmatter followed by body --- horizontal rules
  const src = '---\nname: bar\nmodel: bar\ntier_budget: 800\n---\n\n# Title\n\n---\n\n## Section\n\n---\n';
  const { meta, body } = parseFrontmatter(src);
  assert(meta.name === 'bar',            'body ---: frontmatter parsed correctly');
  assert(body.includes('## Section'),    'body ---: section heading preserved in body');
  assert((body.match(/^---$/mg) || []).length === 2,
    'body ---: both horizontal rules preserved in body');
}

{
  // 4. debug_description field
  const src = '---\nname: x\nmodel: x\ntier_budget: 500\ndebug_description: Debug variant info.\n---\n\nBody.\n';
  const { meta } = parseFrontmatter(src);
  assert(meta.debug_description === 'Debug variant info.', 'debug_description: parsed into meta');
}

{
  // 5. Value containing colon
  const src = '---\nname: y\ndescription: Foo: bar: baz\nmodel: y\ntier_budget: 500\n---\n\nBody.\n';
  const { meta } = parseFrontmatter(src);
  assert(meta.description === 'Foo: bar: baz', 'colon-in-value: description preserved verbatim');
}

{
  // 6. Closing --- with no trailing newline (EOF immediately after ---)
  const src = '---\nname: z\nmodel: z\ntier_budget: 500\n---';  // no \n after closing ---
  const { meta, body } = parseFrontmatter(src);
  assert(Object.keys(meta).length === 0, 'no-trailing-newline: treated as no frontmatter');
  assert(body === src,                   'no-trailing-newline: body equals full input');
}

// ── 2. serializeFrontmatter ───────────────────────────────────────────────────
console.log('\n2. serializeFrontmatter — pure function');

{
  // 7. Non-empty meta
  const meta = { name: 'agent', description: 'Does things', model: 'agent', tier_budget: '800' };
  const out = serializeFrontmatter(meta);
  assert(out.startsWith('---\n'),           'non-empty: starts with ---');
  assert(out.endsWith('\n---\n\n'),         'non-empty: ends with ---\\n\\n');
  assert(out.includes('name: agent'),       'non-empty: name field present');
  assert(out.includes('tier_budget: 800'),  'non-empty: tier_budget field present');
  // Field order preserved (JS insertion order, Node 12+)
  const nameIdx  = out.indexOf('name:');
  const modelIdx = out.indexOf('model:');
  assert(nameIdx < modelIdx, 'non-empty: field order matches insertion order');
}

{
  // 8. Empty meta
  assert(serializeFrontmatter({}) === '', 'empty meta: returns empty string');
}

// ── 3a. compilePrompt — frontmatter with debug_description ───────────────────
console.log('\n3a. compilePrompt — frontmatter with debug_description');

{
  const src = [
    '---',
    'name: myagent',
    'description: Production description.',
    'model: myagent',
    'tier_budget: 1000',
    'debug_description: Debug variant description.',
    '---',
    '',
    '# Agent body',
    '',
    'Some content here.',
    '',
  ].join('\n');

  const { prod, debug } = compile(src, 'myagent');

  // 9–11: prod frontmatter
  assert(fmField(prod, 'name')        === 'myagent',                   '3a: prod name = basename');
  assert(fmField(prod, 'model')       === 'myagent',                   '3a: prod model = basename');
  assert(fmField(prod, 'description') === 'Production description.',    '3a: prod description = prod desc');

  // 12–14: debug frontmatter
  assert(fmField(debug, 'name')        === 'myagent-debug',            '3a: debug name = basename-debug');
  assert(fmField(debug, 'model')       === 'myagent-debug',            '3a: debug model = basename-debug');
  assert(fmField(debug, 'description') === 'Debug variant description.','3a: debug description = debug_description value');

  // 15: debug_description key stripped from both outputs
  assert(!prod.includes('debug_description:'),  '3a: debug_description absent from prod');
  assert(!debug.includes('debug_description:'), '3a: debug_description absent from debug');

  // 16: body preserved
  assert(prod.includes('Some content here.'),   '3a: body preserved in prod');
  assert(debug.includes('Some content here.'),  '3a: body preserved in debug');
}

// ── 3b. compilePrompt — frontmatter without debug_description ────────────────
console.log('\n3b. compilePrompt — frontmatter without debug_description');

{
  const src = [
    '---',
    'name: agent2',
    'description: Shared description.',
    'model: agent2',
    'tier_budget: 500',
    '---',
    '',
    '# Body',
    '',
  ].join('\n');

  const { prod, debug } = compile(src, 'agent2');

  // 17: debug inherits prod description
  assert(fmField(debug, 'description') === 'Shared description.',  '3b: debug inherits prod description when debug_description absent');

  // 18: -debug suffix still applied
  assert(fmField(debug, 'name')  === 'agent2-debug', '3b: debug name gets -debug suffix');
  assert(fmField(debug, 'model') === 'agent2-debug', '3b: debug model gets -debug suffix');
}

// ── 3c. compilePrompt — no frontmatter (backward compat) ─────────────────────
console.log('\n3c. compilePrompt — no frontmatter in source');

{
  const src = '# Just a body\n\nNo frontmatter at all.\n';
  const { prod, debug } = compile(src, 'bare');

  // 19–20: no frontmatter block in outputs
  assert(!prod.startsWith('---'),  '3c: prod has no frontmatter block');
  assert(!debug.startsWith('---'), '3c: debug has no frontmatter block');

  // 21: body preserved
  assert(prod.includes('No frontmatter at all.'),   '3c: body preserved in prod');
  assert(debug.includes('No frontmatter at all.'),  '3c: body preserved in debug');
}

// ── 3d. compilePrompt — <debug_config> stripping ─────────────────────────────
console.log('\n3d. compilePrompt — <debug_config> block stripping');

{
  // 22: single block
  const src = [
    '---',
    'name: dc1',
    'description: Desc.',
    'model: dc1',
    'tier_budget: 500',
    '---',
    '',
    '# Body',
    '',
    '<debug_config>',
    'THINKING_MODE: verbose',
    '</debug_config>',
    '',
    'Normal body content.',
    '',
  ].join('\n');

  const { prod, debug } = compile(src, 'dc1');
  assert(!prod.includes('<debug_config>'),            '3d: single block absent from prod');
  assert(!prod.includes('THINKING_MODE: verbose'),    '3d: block content absent from prod');
  assert(debug.includes('<debug_config>'),            '3d: single block present in debug');
  assert(debug.includes('THINKING_MODE: verbose'),   '3d: block content present in debug');
}

{
  // 23: multiple blocks
  const src = [
    '---',
    'name: dc2',
    'description: Desc.',
    'model: dc2',
    'tier_budget: 500',
    '---',
    '',
    '<debug_config>',
    'BLOCK_ONE: yes',
    '</debug_config>',
    '',
    'Middle content.',
    '',
    '<debug_config>',
    'BLOCK_TWO: yes',
    '</debug_config>',
    '',
    'End content.',
    '',
  ].join('\n');

  const { prod, debug } = compile(src, 'dc2');
  assert(!prod.includes('BLOCK_ONE'),   '3d: first block absent from prod');
  assert(!prod.includes('BLOCK_TWO'),   '3d: second block absent from prod');
  assert(debug.includes('BLOCK_ONE'),   '3d: first block present in debug');
  assert(debug.includes('BLOCK_TWO'),   '3d: second block present in debug');
  assert(prod.includes('Middle content.'),  '3d: body between blocks preserved in prod');
  assert(prod.includes('End content.'),     '3d: body after blocks preserved in prod');
}

// ── 3e. compilePrompt — PRODUCTION CONSTRAINT placement ──────────────────────
console.log('\n3e. compilePrompt — PRODUCTION CONSTRAINT');

{
  const src = '---\nname: pc\ndescription: D.\nmodel: pc\ntier_budget: 500\n---\n\n# Body\n';
  const { prod, debug } = compile(src, 'pc');

  // 24: present in prod
  assert(prod.includes('# PRODUCTION CONSTRAINT'),  '3e: PRODUCTION CONSTRAINT in prod');

  // 25: absent from debug
  assert(!debug.includes('# PRODUCTION CONSTRAINT'), '3e: PRODUCTION CONSTRAINT absent from debug');
}

// ── 3f. Edge case — missing source file ──────────────────────────────────────
console.log('\n3f. compilePrompt — missing source file');

{
  // 26: no crash, no output files written
  withTmpDir(tmp => {
    const srcDir  = path.join(tmp, 'src');
    const distDir = path.join(tmp, 'dist');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(distDir);
    // Do NOT write any source file
    let threw = false;
    try { compilePrompt('ghost.md', srcDir, distDir); }
    catch { threw = true; }
    assert(!threw, '3f: missing source file does not throw');
    assert(!fs.existsSync(path.join(distDir, 'ghost.md')),       '3f: no prod file created');
    assert(!fs.existsSync(path.join(distDir, 'ghost-debug.md')), '3f: no debug file created');
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
