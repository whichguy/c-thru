#!/usr/bin/env node
'use strict';
// Staleness check for hand-authored model-id pins in test/resolve-capability.test.js.
//
// That test's §11 "pinned-model regression guard" asserts exact model strings via
// `want: '<model-id>'` literals. Unlike the lineage snapshot (--update) and the README
// routing table (gen-routing-doc.js), those pins have NO generator — they are
// hand-authored intent, not derived data. This check is the honest substitute:
// flag any pinned id that no longer appears in config/model-map.json#model_routes,
// so a config bump prints "hand-update these lines" instead of a mystery test failure.
//
// An id counts as live if it is a literal model_routes key OR matches an `re:` route
// pattern (all providers — claude, gemini, qwen, gemma, devstral, phi — not a
// Claude-only regex).
//
// Exit 0 always (advisory — `make regen` must complete); warnings go to stderr.
//
// Run: node tools/check-pinned-model-ids.js

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO, 'config', 'model-map.json');
const TEST_PATH = path.join(REPO, 'test', 'resolve-capability.test.js');

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const routeKeys = Object.keys(cfg.model_routes || {});
const literals = new Set(routeKeys.filter((k) => !k.startsWith('re:')));
const patterns = routeKeys
  .filter((k) => k.startsWith('re:'))
  .map((k) => new RegExp(k.slice(3)));

const lines = fs.readFileSync(TEST_PATH, 'utf8').split('\n');
const pins = [];
lines.forEach((line, i) => {
  const m = line.match(/want:\s*'([^']+)'/);
  if (m) pins.push({ line: i + 1, id: m[1] });
});

const stale = pins.filter(
  ({ id }) => !literals.has(id) && !patterns.some((re) => re.test(id))
);

if (stale.length > 0) {
  console.error('⚠ STALE PINS — hand-update these lines in test/resolve-capability.test.js:');
  for (const { line, id } of stale) {
    console.error(`    line ${line}: want: '${id}' — no longer in config/model-map.json#model_routes`);
  }
  console.error('  (these pins have no generator; update the want: values to the intended new ids)');
} else {
  console.log(
    `check-pinned-model-ids: all ${pins.length} pinned ids in resolve-capability.test.js are live in model_routes.`
  );
}
process.exit(0);
