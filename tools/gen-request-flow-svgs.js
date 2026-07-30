#!/usr/bin/env node
'use strict';
//
// gen-request-flow-svgs.js — render the two architecture diagrams from README.md
// and inline them into docs/request-flow.html.
//
// Usage:
//   node tools/gen-request-flow-svgs.js            # render + inline
//   node tools/gen-request-flow-svgs.js --check    # exit 1 if the inlined SVGs are stale
//
// WHY THIS IS A COMMITTED TOOL. The inlining used to be an ad-hoc scratch script,
// and that is exactly how the arrowhead defect happened: it renamed mermaid's
// instance id in the url(#…) REFERENCES but not in the <marker id="…">
// DEFINITIONS, so every arrowhead reference dangled and both diagrams rendered as
// arrowless lines. The fix is to never rename anything — mermaid is told the id it
// should emit, via --svgId, so definitions and references are consistent at source.
//
// WHY IT IS NOT IN test/run-all.sh. It shells out to mermaid-cli, which drives a
// headless Chromium — an external, non-hermetic dependency. test/run-all.sh is
// hermetic and stdlib-only. The OUTPUT is guarded hermetically instead, by
// test/docs-html-integrity.test.js (no dangling refs, no duplicate ids, and the
// smap node-name contract). Run this via `make diagrams` after editing either
// diagram in README.md.
//
// Node stdlib only — no external deps (repo invariant). mermaid-cli is invoked as
// a pinned, one-off subprocess rather than added to package.json, so contributors
// who run `npm install` for eslint do not also pull down Chromium.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const README = path.join(REPO, 'README.md');
const PAGE = path.join(REPO, 'docs', 'request-flow.html');

// Exact pin, no caret. Mermaid's emitted node ids (`flowchart-<name>-<index>`)
// are version-sensitive and the page's step highlighting parses them.
const MERMAID_PKG = '@mermaid-js/mermaid-cli@11.16.0';

// Each diagram is selected by an explicit marker in README.md, never by ordinal
// position — README has six mermaid blocks and reordering them must not silently
// regenerate the page from the wrong diagram.
const DIAGRAMS = [
  { svgId: 'smap-svg', marker: '<!-- diagram-source: smap-svg' },
  { svgId: 'cmap-svg', marker: '<!-- diagram-source: cmap-svg' },
];

// The node names the page's highlighting depends on being recoverable from the
// rendered smap ids. Checked after rendering so a mermaid upgrade that changes the
// id format fails loudly here instead of quietly breaking the page.
const EXPECTED_SMAP_NODES = ['AGENTS', 'HOOK', 'M1', 'M2', 'M3', 'M4', 'PROXY'];

function die(msg) {
  console.error(`gen-request-flow-svgs: ${msg}`);
  process.exit(2);
}

// Pull the fenced mermaid block that immediately follows a marker.
function extractSource(readme, { svgId, marker }) {
  const hits = readme.split(marker).length - 1;
  if (hits !== 1) die(`expected exactly one "${marker}" marker in README.md, found ${hits}.`);
  const at = readme.indexOf(marker);
  const fenceOpen = readme.indexOf('```mermaid', at);
  if (fenceOpen === -1) die(`no \`\`\`mermaid block follows the ${svgId} marker.`);
  const bodyStart = readme.indexOf('\n', fenceOpen) + 1;
  const fenceClose = readme.indexOf('\n```', bodyStart);
  if (fenceClose === -1) die(`unterminated mermaid block for ${svgId}.`);
  return readme.slice(bodyStart, fenceClose);
}

// Mermaid's node "label-container outer-path" shapes are generated with a random
// seed, so consecutive renders of the SAME source differ in their bezier control
// points. That is invisible on screen but makes the output non-idempotent, which
// would render --check useless and dirty the page on every `make diagrams`.
// Pinning handDrawnSeed makes rendering reproducible; verified byte-identical to
// an unseeded render, so this fixes churn without changing appearance.
// Only the large component map actually churns, but both are seeded for symmetry.
const MERMAID_CONFIG = { handDrawnSeed: 1 };

function render(source, svgId, tmpDir) {
  const inFile = path.join(tmpDir, `${svgId}.mmd`);
  const outFile = path.join(tmpDir, `${svgId}.svg`);
  const cfgFile = path.join(tmpDir, 'mermaid-config.json');
  fs.writeFileSync(inFile, source);
  fs.writeFileSync(cfgFile, JSON.stringify(MERMAID_CONFIG));
  const res = spawnSync('npx', ['--yes', MERMAID_PKG, '-i', inFile, '-o', outFile, '--svgId', svgId, '-c', cfgFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error && res.error.code === 'ENOENT') {
    die('npx not found. Install Node.js/npm, then re-run `make diagrams`.');
  }
  if (res.status !== 0 || !fs.existsSync(outFile)) {
    die(`mermaid-cli failed for ${svgId}:\n${(res.stderr || res.stdout || '').trim()}`);
  }

  let svg = fs.readFileSync(outFile, 'utf8').trim();
  // The page container owns the background in both light and dark themes.
  svg = svg.replace(/background-color:\s*white;?/, '');

  if (svgId === 'smap-svg') {
    const names = [...svg.matchAll(/\sid="[^"]*flowchart-([A-Za-z0-9]+)-\d+"/g)].map((m) => m[1]).sort();
    const expected = [...EXPECTED_SMAP_NODES].sort();
    if (names.join(',') !== expected.join(',')) {
      die(`smap node ids changed shape — the page's step highlighting parses these.\n` +
          `  expected: ${expected.join(', ')}\n  got:      ${names.join(', ') || '(none)'}\n` +
          `  This usually means ${MERMAID_PKG} changed its id format. Update the parser in\n` +
          `  docs/request-flow.html and EXPECTED_SMAP_NODES here together.`);
    }
  }
  return svg;
}

// Replace the existing <svg id="…"> … </svg> element in the page.
function spliceSvg(html, svgId, svg) {
  const start = html.indexOf(`<svg id="${svgId}"`);
  if (start === -1) die(`docs/request-flow.html has no inlined <svg id="${svgId}">.`);
  const end = html.indexOf('</svg>', start);
  if (end === -1) die(`unterminated <svg id="${svgId}"> in docs/request-flow.html.`);
  return html.slice(0, start) + svg + html.slice(end + '</svg>'.length);
}

function main() {
  const check = process.argv.includes('--check');
  const readme = fs.readFileSync(README, 'utf8');
  const current = fs.readFileSync(PAGE, 'utf8');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-diagrams-'));
  let next = current;
  try {
    for (const d of DIAGRAMS) {
      next = spliceSvg(next, d.svgId, render(extractSource(readme, d), d.svgId, tmpDir));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (next === current) {
    console.log(`gen-request-flow-svgs: inlined SVGs already current — no change.`);
    return;
  }
  if (check) {
    console.error('gen-request-flow-svgs: inlined SVGs are STALE (a README diagram changed but the page was not regenerated).');
    console.error('\nRun: make diagrams');
    process.exit(1);
  }
  fs.writeFileSync(PAGE, next);
  console.log(`gen-request-flow-svgs: regenerated ${DIAGRAMS.map((d) => d.svgId).join(' + ')} in docs/request-flow.html.`);
}

main();
