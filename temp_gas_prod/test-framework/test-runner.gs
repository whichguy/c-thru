function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * test-runner.gs - Test execution orchestrator
 *
 * Provides functions to run tests by type, repo, or file
 * with LLM-friendly error reporting.
 */

var mocha = require('test-framework/mocha-adapter');
var registry = require('test-framework/test-registry');

/**
 * Safely require a module with error handling
 * @param {string} modulePath - Path to module
 * @returns {boolean} True if loaded successfully
 */
function safeRequire(modulePath) {
  try {
    require(modulePath);
    return true;
  } catch (error) {
    Logger.log('Failed to load test module: ' + modulePath);
    Logger.log('  Error: ' + error.message);
    return false;
  }
}

/**
 * Display test summary
 * @param {Object} summary - Test summary object
 * @param {number} duration - Test duration in ms
 * @param {string} title - Summary title
 */
function displaySummary(summary, duration, title) {
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary: ' + title);
  console.log('='.repeat(60));
  console.log('Total:   ' + summary.total);
  console.log('Passed:  ' + summary.passed + ' OK');
  console.log('Failed:  ' + summary.failed + ' FAIL');
  console.log('Skipped: ' + summary.skipped);
  console.log('Pass Rate: ' + summary.passRate);
  console.log('Duration: ' + duration + 'ms');
  console.log('='.repeat(60) + '\n');
}

/**
 * Run all tests
 * @returns {Object} Aggregated test results
 */
function runAllTests() {
  console.log('Running all tests...\n');

  mocha.resetContext();

  var testModules = registry.discoverAll();
  var loadErrors = 0;

  for (var repo in testModules) {
    var types = testModules[repo];
    for (var type in types) {
      var modules = types[type];
      for (var i = 0; i < modules.length; i++) {
        if (!safeRequire(modules[i])) {
          loadErrors++;
        }
      }
    }
  }

  if (loadErrors > 0) {
    console.log('Warning: ' + loadErrors + ' test module(s) failed to load\n');
  }

  var startTime = Date.now();
  var results = mocha.executeAll();
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, 'All Tests');

  return {
    results: results,
    summary: summary,
    duration: duration,
    loadErrors: loadErrors
  };
}

/**
 * Run only unit tests
 * @returns {Object} Aggregated test results
 */
function runUnitTests() {
  console.log('Running unit tests...\n');

  mocha.resetContext();

  var testModules = registry.discoverUnitTests();
  var loadErrors = 0;

  for (var repo in testModules) {
    var modules = testModules[repo];
    for (var i = 0; i < modules.length; i++) {
      if (!safeRequire(modules[i])) {
        loadErrors++;
      }
    }
  }

  if (loadErrors > 0) {
    console.log('Warning: ' + loadErrors + ' test module(s) failed to load\n');
  }

  var startTime = Date.now();
  var results = mocha.executeAll();
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, 'Unit Tests');

  return {
    results: results,
    summary: summary,
    duration: duration,
    loadErrors: loadErrors
  };
}

/**
 * Run only integration tests
 * @returns {Object} Aggregated test results
 */
function runIntegrationTests() {
  console.log('Running integration tests...\n');

  mocha.resetContext();

  var testModules = registry.discoverIntegrationTests();
  var loadErrors = 0;

  for (var repo in testModules) {
    var modules = testModules[repo];
    for (var i = 0; i < modules.length; i++) {
      if (!safeRequire(modules[i])) {
        loadErrors++;
      }
    }
  }

  if (loadErrors > 0) {
    console.log('Warning: ' + loadErrors + ' test module(s) failed to load\n');
  }

  var startTime = Date.now();
  var results = mocha.executeAll();
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, 'Integration Tests');

  return {
    results: results,
    summary: summary,
    duration: duration,
    loadErrors: loadErrors
  };
}

/**
 * Run tests for a specific repo
 * @param {string} repoName - Repository name (e.g., 'common-js', 'sheets-chat')
 * @returns {Object} Aggregated test results
 */
function runRepoTests(repoName) {
  console.log('Running tests for ' + repoName + '...\n');

  mocha.resetContext();

  var testModules = registry.discoverRepoTests(repoName);

  if (!testModules) {
    console.log('No tests found for repo: ' + repoName + '\n');
    return {
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 'N/A' },
      duration: 0
    };
  }

  var loadErrors = 0;

  for (var type in testModules) {
    var modules = testModules[type];
    for (var i = 0; i < modules.length; i++) {
      if (!safeRequire(modules[i])) {
        loadErrors++;
      }
    }
  }

  if (loadErrors > 0) {
    console.log('Warning: ' + loadErrors + ' test module(s) failed to load\n');
  }

  var startTime = Date.now();
  var results = mocha.executeAll();
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, repoName);

  return {
    results: results,
    summary: summary,
    duration: duration,
    loadErrors: loadErrors
  };
}

/**
 * Run tests for a specific repo and type
 * @param {string} repoName - Repository name
 * @param {string} type - Test type ('unit' or 'integration')
 * @returns {Object} Aggregated test results
 */
function runRepoTypeTests(repoName, type) {
  console.log('Running ' + type + ' tests for ' + repoName + '...\n');

  mocha.resetContext();

  var testModules = registry.discoverRepoTypeTests(repoName, type);

  if (!testModules || testModules.length === 0) {
    console.log('No ' + type + ' tests found for repo: ' + repoName + '\n');
    return {
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 'N/A' },
      duration: 0
    };
  }

  var loadErrors = 0;

  for (var i = 0; i < testModules.length; i++) {
    if (!safeRequire(testModules[i])) {
      loadErrors++;
    }
  }

  if (loadErrors > 0) {
    console.log('Warning: ' + loadErrors + ' test module(s) failed to load\n');
  }

  var startTime = Date.now();
  var results = mocha.executeAll();
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, repoName + ' ' + type);

  return {
    results: results,
    summary: summary,
    duration: duration,
    loadErrors: loadErrors
  };
}

/**
 * Run a specific test file
 * @param {string} testPath - Full path to test file
 * @returns {Object} Aggregated test results
 */
function runTestFile(testPath) {
  console.log('Running test file: ' + testPath + '...\n');

  mocha.resetContext();

  if (!safeRequire(testPath)) {
    console.log('Failed to load test file: ' + testPath + '\n');
    return {
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 'N/A' },
      duration: 0,
      error: 'Failed to load test file'
    };
  }

  var startTime = Date.now();
  var results = mocha.executeAll();
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, testPath);

  return {
    results: results,
    summary: summary,
    duration: duration
  };
}

/**
 * Run tests matching a grep pattern
 * @param {string|RegExp} pattern - Pattern to match test names
 * @returns {Object} Aggregated test results
 */
function runTestsWithGrep(pattern) {
  console.log('Running tests matching: ' + pattern + '...\n');

  mocha.resetContext();

  var testModules = registry.discoverAll();
  var loadErrors = 0;

  for (var repo in testModules) {
    var types = testModules[repo];
    for (var type in types) {
      var modules = types[type];
      for (var i = 0; i < modules.length; i++) {
        if (!safeRequire(modules[i])) {
          loadErrors++;
        }
      }
    }
  }

  if (loadErrors > 0) {
    console.log('Warning: ' + loadErrors + ' test module(s) failed to load\n');
  }

  var startTime = Date.now();
  var results = mocha.executeAll({ grep: pattern });
  var duration = Date.now() - startTime;

  var formatted = mocha.formatResults(results);
  console.log(formatted);

  var summary = mocha.getSummary(results);
  displaySummary(summary, duration, 'Grep: ' + pattern);

  return {
    results: results,
    summary: summary,
    duration: duration,
    loadErrors: loadErrors
  };
}

// Export public API
module.exports = {
  runAllTests: runAllTests,
  runUnitTests: runUnitTests,
  runIntegrationTests: runIntegrationTests,
  runRepoTests: runRepoTests,
  runRepoTypeTests: runRepoTypeTests,
  runTestFile: runTestFile,
  runTestsWithGrep: runTestsWithGrep,
  safeRequire: safeRequire
};
}
__defineModule__(_main);
