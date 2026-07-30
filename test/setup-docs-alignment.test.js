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
ok(fs.existsSync(path.join(root, 'tools/c-thru-plugin-hook-gate.sh')), 'plugin-hook-gate exists');
ok(fs.existsSync(path.join(root, 'commands/c-thru-install-cli.md')), 'install-cli command exists');

const sessionStart = read('tools/c-thru-session-start.sh');
ok(!/git\s+clone/.test(sessionStart), 'session-start must not git clone');
ok(sessionStart.includes('install-cli'), 'session-start points to install-cli');
ok(sessionStart.includes('c-thru-plugin-hook-gate'), 'session-start sources gate');

const hooksJson = read('plugins/c-thru/hooks/hooks.json');
ok(hooksJson.includes('C_THRU_PLUGIN_HOOK=1'), 'hooks.json sets plugin hook env');

ok(mkt.includes('install-cli') || mkt.includes('c-thru-install-cli'),
  'marketplace-release mentions install-cli');
ok(!/SessionStart runs.*bootstrap|SessionStart.*git clone/i.test(mkt) ||
   mkt.includes('install-cli'),
  'marketplace-release does not claim SessionStart is primary bootstrap without install-cli');

const pluginReadmeBody = pluginReadme;
ok(pluginReadmeBody.includes('install-cli') || pluginReadmeBody.includes('cthru'),
  'plugin README Shape C path');
ok(pluginReadmeBody.includes('/c-thru:install-cli') ||
   pluginReadmeBody.includes('install-cli') ||
   pluginReadmeBody.includes('bootstrap'),
  'plugin README bootstrap path documented');

// Lean marketplace: no fat skill tree in plugin package
const leanSkills = ['c-thru-plan', 'c-thru-config', 'c-thru-control', 'plan-page', 'advisors'];
for (const s of leanSkills) {
  ok(!fs.existsSync(path.join(root, 'plugins/c-thru/skills', s, 'SKILL.md')),
    `lean: plugins/c-thru/skills/${s} must not ship`);
}
ok(fs.existsSync(path.join(root, 'plugins/c-thru/commands/c-thru-install-cli.md')),
  'bundle has install-cli command');
ok(fs.existsSync(path.join(root, 'plugins/c-thru/tools/c-thru-plugin-hook-gate.sh')),
  'bundle has plugin-hook-gate');

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

ok(fs.existsSync(path.join(root, 'test/shape-c-spec-contract.test.js')) || fs.existsSync(path.join(root, 'test/shape-c-spec-contract.test.sh')),
  'shape-c-spec-contract test exists');
const envDocs = read('docs/env-vars.md');
ok(envDocs.includes('C_THRU_FROM_CLI') || envDocs.includes('C_THRU_PLUGIN_LITE'),
  'env-vars documents Shape C gate vars');
ok(envDocs.includes('C_THRU_ALLOW_UNPINNED') || read('docs/marketplace-release.md').includes('ALLOW_UNPINNED') || read('uninstall.sh').includes('purge-src'),
  'uninstall purge-src or allow-unpinned documented');
ok(read('uninstall.sh').includes('--purge-src'), 'uninstall supports --purge-src');

console.log('setup-docs-alignment: ok');
