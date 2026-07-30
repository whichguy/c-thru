#!/usr/bin/env node
// Shape C / private-marketplace setup-docs contract.
// Hermetic: string presence only (no network).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fails = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    fails++;
  }
}

const readme = read('README.md');
const mkt = read('docs/marketplace-release.md');
const sec = read('SECURITY.md');
const pluginReadme = read('plugins/c-thru/README.md');
const getting = read('docs/getting-started.md');
const messages = read('tools/c-thru-setup-messages.sh');

ok(readme.includes('cthru'), 'README mentions cthru runtime');
ok(readme.includes('marketplace add whichguy/c-thru'), 'README private marketplace install');
ok(/Pick exactly one|exactly one marketplace/i.test(readme), 'README choose-one identity');
ok(!/claude-community|plugin-directory-submission/.test(readme), 'README not primary Anthropic community');
ok(!/claude-community|plugin-directory-submission/.test(mkt), 'marketplace-release not community-primary');
ok(readme.includes('ANTHROPIC_BASE_URL'), 'README removing/base URL');
ok(sec.includes('ANTHROPIC_BASE_URL'), 'SECURITY base URL');
ok(sec.includes('pkill') || sec.includes('claude-proxy'), 'SECURITY proxy stop');
ok(pluginReadme.includes('cthru') || pluginReadme.includes('c-thru'), 'plugin README CLI name');
ok(pluginReadme.includes('marketplace add whichguy/c-thru'), 'plugin README marketplace');
ok(getting.includes('install.sh'), 'getting-started still has contributor install');
ok(getting.includes('cthru') || getting.includes('c-thru'), 'getting-started mentions CLI');
ok(messages.includes('Shape C') || messages.includes('cthru'), 'setup-messages Shape C');
ok(fs.existsSync(path.join(root, 'tools/c-thru-install-core.sh')), 'install-core exists');
ok(fs.existsSync(path.join(root, 'tools/c-thru-plugin-bootstrap.sh')), 'bootstrap exists');

const market = JSON.parse(read('.claude-plugin/marketplace.json'));
const plugin = JSON.parse(read('plugins/c-thru/.claude-plugin/plugin.json'));
ok(market.plugins[0].version === plugin.version, 'marketplace/plugin version lockstep');
ok(String(market.plugins[0].description || '').toLowerCase().includes('cli') ||
   String(plugin.description || '').toLowerCase().includes('cli') ||
   String(plugin.description || '').toLowerCase().includes('fleet'),
  'plugin description mentions CLI/fleet honesty');

if (fails) {
  console.error(`setup-docs-alignment: ${fails} failure(s)`);
  process.exit(1);
}
console.log('setup-docs-alignment: ok');
