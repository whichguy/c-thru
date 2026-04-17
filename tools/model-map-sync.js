#!/usr/bin/env node
'use strict';

const path = require('path');
const { syncLayeredConfig } = require('./model-map-layered.js');

function fail(message) {
  console.error(`model-map-sync: ${message}`);
  process.exit(1);
}

function main() {
  const [, , defaultsPathArg, overridesPathArg, effectivePathArg, bootstrapPathArg] = process.argv;
  if (!defaultsPathArg || !overridesPathArg || !effectivePathArg) {
    fail('usage: model-map-sync.js <defaults-path> <overrides-path> <effective-output-path> [bootstrap-effective-path]');
  }

  const defaultsPath = path.resolve(defaultsPathArg);
  const overridesPath = path.resolve(overridesPathArg);
  const effectivePath = path.resolve(effectivePathArg);
  const bootstrapPath = bootstrapPathArg ? path.resolve(bootstrapPathArg) : null;

  try {
    const result = syncLayeredConfig(defaultsPath, overridesPath, effectivePath, bootstrapPath);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      defaults_path: defaultsPath,
      overrides_path: overridesPath,
      effective_path: effectivePath,
      override_keys: Object.keys(result.overrides).sort(),
    }, null, 2)}\n`);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) {
  main();
}
