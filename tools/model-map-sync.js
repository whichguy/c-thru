#!/usr/bin/env node
'use strict';

const path = require('path');
const { syncLayeredConfig } = require('./model-map-layered.js');

function fail(message) {
  console.error(`model-map-sync: ${message}`);
  process.exit(1);
}

function main() {
  const [, , defaultsPathArg, globalPathArg, projectPathArg, effectivePathArg, bootstrapPathArg] = process.argv;
  if (!defaultsPathArg || !globalPathArg || !effectivePathArg) {
    fail('usage: model-map-sync.js <defaults-path> <global-path> <project-path> <effective-output-path> [bootstrap-effective-path]');
  }

  const defaultsPath = path.resolve(defaultsPathArg);
  const globalPath = path.resolve(globalPathArg);
  const projectPath = projectPathArg ? path.resolve(projectPathArg) : null;
  const effectivePath = path.resolve(effectivePathArg);
  const bootstrapPath = bootstrapPathArg ? path.resolve(bootstrapPathArg) : null;

  try {
    const result = syncLayeredConfig(defaultsPath, globalPath, projectPath, effectivePath, bootstrapPath);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      defaults_path: defaultsPath,
      global_path: globalPath,
      project_path: projectPath,
      effective_path: effectivePath,
      override_keys: Object.keys(result.projectOverrides).length > 0 
        ? Object.keys(result.projectOverrides).sort() 
        : Object.keys(result.globalOverrides).sort(),
    }, null, 2)}\n`);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) {
  main();
}
