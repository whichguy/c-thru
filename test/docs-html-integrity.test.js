#!/usr/bin/env node
'use strict';
// docs-html-integrity.test.js — structural invariants for the self-contained
// HTML doc pages under docs/.
//
// REFERENCED in test/run-all.sh — registered via run_suite in the Validators block.
//
// Why this exists: docs/request-flow.html inlines mermaid-rendered SVGs. The
// inlining rewrites mermaid's instance id so the two SVGs cannot collide. A
// hand-rolled version of that rewrite renamed the url(#…) REFERENCES but not the
// <marker id="…"> DEFINITIONS, so every arrowhead reference dangled and both
// diagrams rendered as arrowless lines. It shipped unnoticed because the diagrams
// were reviewed as standalone mermaid-cli output rather than in the page.
//
// These checks are hermetic (stdlib only, no browser, no network). They do NOT
// re-render anything — regenerating the SVGs needs mermaid-cli and lives behind
// `make diagrams`, deliberately outside this suite.
//
// Stdlib-only — no external deps.

const fs = require('fs');
const path = require('path');
const { assert, assertEq, summary } = require('./helpers');

const DOCS_DIR = path.resolve(__dirname, '..', 'docs');

// ── Extraction ─────────────────────────────────────────────────────────────
//
// The leading \s in ID_RE is load-bearing. A naive /id="([^"]+)"/ also matches
// data-id="…", which mermaid emits on every edge label, and reports 53 phantom
// duplicates in request-flow.html where only 14 are real. Requiring whitespace
// immediately before `id` excludes data-id, aria-labelledby, etc.
const ID_RE = /\sid\s*=\s*("([^"]*)"|'([^']*)')/g;

// url(#x) / url("#x") / url('#x'), tolerating inner whitespace.
const URL_REF_RE = /url\(\s*(?:"#([^"]+)"|'#([^']+)'|#([^)\s'"]+))\s*\)/g;

// href="#x" / xlink:href='#x' — local fragments only.
const HREF_REF_RE = /(?:xlink:)?href\s*=\s*(?:"#([^"]*)"|'#([^']*)')/g;

// External subresources: any src=/href= pointing at a scheme or protocol-relative
// URL, plus url(http…) inside CSS.
const EXTERNAL_RE = /(?:\b(?:src|href)\s*=\s*["'](?:[a-z][a-z0-9+.-]*:)?\/\/|url\(\s*["']?(?:[a-z][a-z0-9+.-]*:)?\/\/)/gi;

function allMatches(re, text, groups) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    for (const g of groups) {
      if (m[g] !== undefined) { out.push(m[g]); break; }
    }
  }
  return out;
}

const extractIds = (t) => allMatches(ID_RE, t, [2, 3]);
const extractRefs = (t) => [
  ...allMatches(URL_REF_RE, t, [1, 2, 3]),
  ...allMatches(HREF_REF_RE, t, [1, 2]),
];

// ── Self-test of the extractors ────────────────────────────────────────────
// The regexes are the whole test. Prove them against fixtures rather than
// trusting them, so a future tweak can't silently stop detecting anything.
function selfTest() {
  console.log('\nextractor fixtures');

  const idFixture = `<svg id="a"><g data-id="NOT_AN_ID" id='b'></g><rect aria-labelledby="nope" id = "c"/></svg>`;
  const ids = extractIds(idFixture);
  assertEq(ids.join(','), 'a,b,c', 'ids: both quote styles and spaced form, data-id excluded');

  const refFixture = `marker-end="url(#m1)" fill='url("#m2")' stroke="url( '#m3' )" ` +
                     `<use href="#u1"/><use xlink:href='#u2'/><a href="https://example.com">`;
  const refs = extractRefs(refFixture);
  assertEq(refs.sort().join(','), 'm1,m2,m3,u1,u2', 'refs: url() all quote styles + href/xlink:href, absolute href ignored');

  assertEq(extractIds('<div data-id="x">').length, 0, 'data-id alone yields no ids');
  assert(EXTERNAL_RE.test('<script src="https://cdn.example.com/x.js">'), 'external: absolute src detected');
  EXTERNAL_RE.lastIndex = 0;
  assert(EXTERNAL_RE.test('<link href="//cdn.example.com/x.css">'), 'external: protocol-relative href detected');
  EXTERNAL_RE.lastIndex = 0;
  assert(!EXTERNAL_RE.test('<a href="../README.md#anchor">'), 'external: relative href not flagged');
  EXTERNAL_RE.lastIndex = 0;
  assert(!EXTERNAL_RE.test('marker-end="url(#local)"'), 'external: local url(#…) not flagged');
  EXTERNAL_RE.lastIndex = 0;
}

// ── Per-file invariants ────────────────────────────────────────────────────
function checkFile(file) {
  const rel = path.join('docs', path.basename(file));
  const text = fs.readFileSync(file, 'utf8');
  console.log(`\n${rel}`);

  const ids = extractIds(text);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
  assert(dupes.length === 0, `no duplicate ids${dupes.length ? ` — found ${dupes.length}: ${dupes.slice(0, 6).join(', ')}` : ''}`);

  const defined = new Set(ids);
  const dangling = [...new Set(extractRefs(text))].filter((r) => !defined.has(r));
  assert(dangling.length === 0, `every local fragment reference resolves${dangling.length ? ` — dangling: ${dangling.join(', ')}` : ''}`);

  EXTERNAL_RE.lastIndex = 0;
  const external = text.match(EXTERNAL_RE) || [];
  assert(external.length === 0, `no external subresources${external.length ? ` — found ${external.length}: ${external.slice(0, 3).join(', ')}` : ''}`);
}

// ── request-flow.html selector contract ────────────────────────────────────
// Pins the DOM shape the page's own step-through highlighting depends on, so a
// mermaid CLI upgrade that changes emitted ids fails here rather than silently
// degrading the page.
const EXPECTED_SMAP_NODES = ['AGENTS', 'HOOK', 'PROXY', 'M1', 'M2', 'M3', 'M4'];

function checkRequestFlowContract(file) {
  const text = fs.readFileSync(file, 'utf8');
  console.log('\ndocs/request-flow.html — selector contract');

  for (const id of ['smap-svg', 'cmap-svg']) {
    assert(text.includes(`<svg id="${id}"`), `inlined <svg id="${id}"> present`);
  }

  const start = text.indexOf('<svg id="smap-svg"');
  const smap = start === -1 ? '' : text.slice(start, text.indexOf('</svg>', start));
  const names = [...smap.matchAll(/\sid="[^"]*flowchart-([A-Za-z0-9]+)-\d+"/g)].map((m) => m[1]);
  assertEq(names.length, EXPECTED_SMAP_NODES.length, 'smap-svg node count');
  assertEq([...names].sort().join(','), [...EXPECTED_SMAP_NODES].sort().join(','),
    'smap-svg node names recoverable from ids');
}

function main() {
  const files = fs.readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(DOCS_DIR, f))
    .sort();

  selfTest();
  assert(files.length > 0, `found ${files.length} html file(s) under docs/`);
  for (const f of files) checkFile(f);

  const rf = path.join(DOCS_DIR, 'request-flow.html');
  if (fs.existsSync(rf)) checkRequestFlowContract(rf);

  process.exit(summary() === 0 ? 0 : 1);
}

main();
