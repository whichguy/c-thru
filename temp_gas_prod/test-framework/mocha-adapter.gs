function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * mocha-adapter.gs - Mocha-style BDD test framework for GAS
   *
   * Provides describe/it/hooks with LLM-friendly error reporting.
   */

  var diffUtils = require('test-framework/diff-utils');
  var fixHints = require('test-framework/fix-hints');

  // Test state
  var suites = [];
  var currentSuite = null;
  var testResults = [];
  var hooks = {
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: []
  };

  /**
   * TestContext - Provides context capture for tests
   */
  function TestContext() {
    this.customContext = {};
    this.customHints = [];
    this.currentTest = null;
    this.executionLog = [];
  }

  TestContext.prototype.context = function(data) {
    Object.assign(this.customContext, data);
  };

  TestContext.prototype.hint = function(hint) {
    this.customHints.push(hint);
  };

  TestContext.prototype.log = function(message) {
    this.executionLog.push({
      time: Date.now(),
      message: message
    });
  };

  TestContext.prototype.reset = function() {
    this.customContext = {};
    this.customHints = [];
    this.executionLog = [];
  };

  var testContext = new TestContext();

  /**
   * Define a test suite
   * @param {string} name - Suite name
   * @param {Function} fn - Suite definition function
   */
  function describe(name, fn) {
    var suite = {
      name: name,
      tests: [],
      suites: [],
      parent: currentSuite,
      beforeAll: [],
      afterAll: [],
      beforeEach: [],
      afterEach: []
    };

    if (currentSuite) {
      currentSuite.suites.push(suite);
    } else {
      suites.push(suite);
    }

    var previousSuite = currentSuite;
    currentSuite = suite;

    try {
      fn();
    } finally {
      currentSuite = previousSuite;
    }
  }

  /**
   * Define a test case
   * @param {string} name - Test name
   * @param {Function} fn - Test function
   */
  function it(name, fn) {
    if (!currentSuite) {
      throw new Error('it() must be called within describe()');
    }

    currentSuite.tests.push({
      name: name,
      fn: fn,
      suite: currentSuite
    });
  }

  /**
   * Skip a test
   */
  it.skip = function(name, fn) {
    if (!currentSuite) {
      throw new Error('it.skip() must be called within describe()');
    }

    currentSuite.tests.push({
      name: name,
      fn: fn,
      suite: currentSuite,
      skipped: true
    });
  };

  /**
   * Focus on a test (only run this one)
   */
  it.only = function(name, fn) {
    if (!currentSuite) {
      throw new Error('it.only() must be called within describe()');
    }

    currentSuite.tests.push({
      name: name,
      fn: fn,
      suite: currentSuite,
      only: true
    });
  };

  // Hook definitions
  function beforeAll(fn) {
    if (currentSuite) {
      currentSuite.beforeAll.push(fn);
    } else {
      hooks.beforeAll.push(fn);
    }
  }

  function afterAll(fn) {
    if (currentSuite) {
      currentSuite.afterAll.push(fn);
    } else {
      hooks.afterAll.push(fn);
    }
  }

  function beforeEach(fn) {
    if (currentSuite) {
      currentSuite.beforeEach.push(fn);
    } else {
      hooks.beforeEach.push(fn);
    }
  }

  function afterEach(fn) {
    if (currentSuite) {
      currentSuite.afterEach.push(fn);
    } else {
      hooks.afterEach.push(fn);
    }
  }

  /**
   * Get full suite path for a test
   * @param {Object} test - Test object
   * @returns {Array<string>} Suite names from root to test
   */
  function getSuitePath(test) {
    var path = [];
    var suite = test.suite;
    while (suite) {
      path.unshift(suite.name);
      suite = suite.parent;
    }
    return path;
  }

  /**
   * Check if test name matches grep pattern
   * @param {string} name - Test name
   * @param {string|RegExp} grep - Pattern to match
   * @returns {boolean} True if matches
   */
  function matchesGrep(name, grep) {
    if (!grep) return true;
    if (!name) return false;

    if (typeof grep === 'string') {
      return name.toLowerCase().indexOf(grep.toLowerCase()) !== -1;
    }
    if (grep instanceof RegExp) {
      return grep.test(name);
    }
    return true;
  }

  /**
   * Collect all beforeEach hooks for a test (including parent suites)
   * @param {Object} test - Test object
   * @returns {Array<Function>} Hooks in order
   */
  function collectBeforeEachHooks(test) {
    var allHooks = hooks.beforeEach.slice();
    var suiteStack = [];
    var suite = test.suite;

    while (suite) {
      suiteStack.unshift(suite);
      suite = suite.parent;
    }

    suiteStack.forEach(function(s) {
      allHooks = allHooks.concat(s.beforeEach);
    });

    return allHooks;
  }

  /**
   * Collect all afterEach hooks for a test (including parent suites)
   * @param {Object} test - Test object
   * @returns {Array<Function>} Hooks in reverse order
   */
  function collectAfterEachHooks(test) {
    var allHooks = [];
    var suiteStack = [];
    var suite = test.suite;

    while (suite) {
      suiteStack.unshift(suite);
      suite = suite.parent;
    }

    // Reverse order for afterEach
    suiteStack.reverse().forEach(function(s) {
      allHooks = allHooks.concat(s.afterEach);
    });

    allHooks = allHooks.concat(hooks.afterEach);
    return allHooks;
  }

  /**
   * Extract line number from stack trace
   * @param {string} stack - Error stack trace
   * @returns {number|null} Line number or null
   */
  function extractLineNumber(stack) {
    if (!stack) return null;

    var match = stack.match(/:(\d+):\d+/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Build LLM report from test error
   * @param {Object} test - Test object
   * @param {Error} error - Test error
   * @returns {Object} LLM report object
   */
  function buildLlmReport(test, error) {
    var llmReport = error.llmReport || {};

    return {
      whatFailed: {
        test: test.name,
        suite: getSuitePath(test),
        line: extractLineNumber(error.stack),
        assertion: llmReport.assertion || null
      },
      whatCalled: {
        context: testContext.customContext,
        logs: testContext.executionLog.slice(-20)
      },
      values: llmReport.values || null,
      diff: llmReport.diff || null,
      fixHints: fixHints.getAllHints(llmReport, {
        hints: testContext.customHints,
        domain: testContext.customContext.domain
      })
    };
  }

  /**
   * Format LLM report for console output
   * @param {Object} report - LLM report object
   * @returns {string} Formatted report
   */
  function formatLlmReport(report) {
    var lines = [];
    var divider = '═'.repeat(70);

    lines.push(divider);
    lines.push('TEST FAILURE REPORT');
    lines.push(divider);

    // 1. What Failed
    lines.push('');
    lines.push('1. WHAT FAILED');
    lines.push(`   Test: ${report.whatFailed.test}`);
    lines.push(`   Suite: ${report.whatFailed.suite.join(' > ')}`);
    if (report.whatFailed.line) {
      lines.push(`   Line: ${report.whatFailed.line}`);
    }
    if (report.whatFailed.assertion) {
      lines.push(`   Assertion: ${report.whatFailed.assertion.method}`);
    }

    // 2. What Was Called
    if (report.whatCalled.context && Object.keys(report.whatCalled.context).length) {
      lines.push('');
      lines.push('2. CONTEXT');
      Object.keys(report.whatCalled.context).forEach(function(key) {
        lines.push(`   ${key}: ${JSON.stringify(report.whatCalled.context[key])}`);
      });
    }

    // 3. Expected vs Actual
    if (report.values) {
      lines.push('');
      lines.push('3. EXPECTED vs ACTUAL');
      lines.push(`   Expected: ${diffUtils.safeStringify(report.values.expected, 200)}`);
      lines.push(`   Actual:   ${diffUtils.safeStringify(report.values.actual, 200)}`);

      if (report.diff) {
        lines.push('');
        lines.push(`   DIFF: ${report.diff.summary}`);
        var formattedDiff = diffUtils.formatDiff(report.diff, 2);
        if (formattedDiff) {
          lines.push(formattedDiff);
        }
      }
    }

    // 4. Fix Hints
    if (report.fixHints && report.fixHints.length) {
      lines.push('');
      lines.push('4. FIX HINTS');
      report.fixHints.forEach(function(hint) {
        lines.push(`   → ${hint}`);
      });
    }

    lines.push(divider);

    return lines.join('\n');
  }

  /**
   * Execute a single test
   * @param {Object} test - Test object
   * @returns {Object} Test result
   */
  function executeTest(test) {
    var result = {
      name: test.name,
      suite: getSuitePath(test),
      passed: false,
      skipped: test.skipped || false,
      duration: 0,
      error: null,
      llmReport: null
    };

    if (test.skipped) {
      result.passed = true;
      return result;
    }

    var startTime = Date.now();
    var testError = null;
    var afterEachError = null;
    var testPassed = false;

    // Reset context for this test
    testContext.reset();
    testContext.currentTest = test;

    // Collect hooks
    var beforeEachHooks = collectBeforeEachHooks(test);
    var afterEachHooks = collectAfterEachHooks(test);

    try {
      // Run beforeEach hooks
      beforeEachHooks.forEach(function(hook) {
        hook.call(testContext);
      });

      // Run test
      test.fn.call(testContext);
      testPassed = true;

    } catch (error) {
      testError = error;
      testPassed = false;
    } finally {
      // Run afterEach hooks in finally block (always runs)
      try {
        afterEachHooks.forEach(function(hook) {
          hook.call(testContext);
        });
      } catch (hookError) {
        afterEachError = hookError;
      }

      testContext.currentTest = null;
    }

    // Handle error consolidation
    if (afterEachError) {
      if (testPassed) {
        // afterEach failure becomes the test failure
        testError = afterEachError;
        testPassed = false;
      } else {
        // Both failed - attach afterEach error to main error
        testError.afterEachError = {
          message: afterEachError.message,
          stack: afterEachError.stack
        };
      }
    }

    result.duration = Date.now() - startTime;
    result.passed = testPassed;

    if (testError) {
      result.error = {
        message: testError.message,
        stack: testError.stack
      };
      result.llmReport = buildLlmReport(test, testError);
    }

    return result;
  }

  /**
   * Run all tests in a suite
   * @param {Object} suite - Suite object
   * @param {Object} options - Run options
   * @returns {Array<Object>} Test results
   */
  function runSuite(suite, options) {
    options = options || {};
    var results = [];

    // Run beforeAll hooks
    suite.beforeAll.forEach(function(hook) {
      hook.call(testContext);
    });

    // Run tests
    suite.tests.forEach(function(test) {
      var fullName = `${getSuitePath(test).join(' > ')} > ${test.name}`;

      if (!matchesGrep(fullName, options.grep)) {
        return;
      }

      var result = executeTest(test);
      results.push(result);
      testResults.push(result);
    });

    // Run nested suites
    suite.suites.forEach(function(nestedSuite) {
      var nestedResults = runSuite(nestedSuite, options);
      results = results.concat(nestedResults);
    });

    // Run afterAll hooks
    suite.afterAll.forEach(function(hook) {
      hook.call(testContext);
    });

    return results;
  }

  /**
   * Run all registered tests
   * @param {Object} options - Run options (grep, etc.)
   * @returns {Object} Summary with results
   */
  function runTests(options) {
    options = options || {};
    testResults = [];

    // Run global beforeAll
    hooks.beforeAll.forEach(function(hook) {
      hook.call(testContext);
    });

    // Check for .only tests
    var hasOnly = false;
    function checkOnly(suite) {
      suite.tests.forEach(function(test) {
        if (test.only) hasOnly = true;
      });
      suite.suites.forEach(checkOnly);
    }
    suites.forEach(checkOnly);

    // If .only exists, skip non-only tests
    if (hasOnly) {
      function markSkipped(suite) {
        suite.tests.forEach(function(test) {
          if (!test.only) test.skipped = true;
        });
        suite.suites.forEach(markSkipped);
      }
      suites.forEach(markSkipped);
    }

    // Run all suites
    suites.forEach(function(suite) {
      runSuite(suite, options);
    });

    // Run global afterAll
    hooks.afterAll.forEach(function(hook) {
      hook.call(testContext);
    });

    // Build summary
    var passed = testResults.filter(function(r) { return r.passed && !r.skipped; }).length;
    var failed = testResults.filter(function(r) { return !r.passed && !r.skipped; }).length;
    var skipped = testResults.filter(function(r) { return r.skipped; }).length;

    return {
      total: testResults.length,
      passed: passed,
      failed: failed,
      skipped: skipped,
      results: testResults
    };
  }

  /**
   * Reset test state
   */
  function resetTests() {
    suites = [];
    currentSuite = null;
    testResults = [];
    hooks = {
      beforeAll: [],
      afterAll: [],
      beforeEach: [],
      afterEach: []
    };
    testContext.reset();
  }

  /**
   * Get the test context for the current test
   * @returns {TestContext} Current test context
   */
  function getTestContext() {
    return testContext;
  }

  /**
   * Format test results for console output
   * @param {Array} results - Test results array
   * @returns {string} Formatted output
   */
  function formatResults(results) {
    var lines = [];

    results.forEach(function(result) {
      var prefix = result.passed ? '  ✓' : '  ✗';
      if (result.skipped) prefix = '  -';

      var suitePath = result.suite.join(' > ');
      lines.push(`${prefix} ${suitePath} > ${result.name}`);

      if (!result.passed && !result.skipped && result.error) {
        lines.push(`      Error: ${result.error.message}`);

        if (result.llmReport) {
          lines.push('');
          lines.push(formatLlmReport(result.llmReport));
        }
      }
    });

    return lines.join('\n');
  }

  /**
   * Get summary statistics
   * @param {Array} results - Test results array
   * @returns {Object} Summary object
   */
  function getSummary(results) {
    var passed = results.filter(function(r) { return r.passed && !r.skipped; }).length;
    var failed = results.filter(function(r) { return !r.passed && !r.skipped; }).length;
    var skipped = results.filter(function(r) { return r.skipped; }).length;
    var total = results.length;

    var passRate = total > 0 ? Math.round((passed / (total - skipped)) * 100) + '%' : 'N/A';

    return {
      total: total,
      passed: passed,
      failed: failed,
      skipped: skipped,
      passRate: passRate
    };
  }

  /**
   * Execute all registered tests
   * @param {Object} options - Run options
   * @returns {Array} Test results
   */
  function executeAll(options) {
    var summary = runTests(options);
    return summary.results;
  }

  /**
   * Reset test context (alias for resetTests)
   */
  function resetContext() {
    resetTests();
  }

  // Export for CommonJS
  module.exports = {
    // BDD interface
    describe: describe,
    it: it,
    before: beforeAll,       // Mocha alias
    after: afterAll,         // Mocha alias
    beforeAll: beforeAll,
    afterAll: afterAll,
    beforeEach: beforeEach,
    afterEach: afterEach,

    // Execution
    run: runTests,           // Convenience alias used by test files
    runTests: runTests,
    executeAll: executeAll,

    // Reset
    resetTests: resetTests,
    resetContext: resetContext,

    // Results
    formatResults: formatResults,
    getSummary: getSummary,
    formatLlmReport: formatLlmReport,
    buildLlmReport: buildLlmReport,

    // Context
    getTestContext: getTestContext,
    TestContext: TestContext
  };
}

__defineModule__(_main);