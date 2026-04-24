function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ToolTestRunner - Executes and manages tool tests from _Tests sheet
   *
   * Tests serve two audiences:
   * 1. LLM - Understand tool behavior, use for debugging, see expected inputs/outputs
   * 2. Sidebar UI - Humans can run tests to verify tool functionality
   *
   * Test File Format (in _Tests sheet or synced from GitHub):
   * module.exports = {
   *   name: 'usaw_rankings_test',
   *   description: 'Tests for usaw_rankings tool',
   *   examples: [{ input: {weight_class_id: 81}, description: 'Get 81kg rankings' }],
   *   expects: 'Array<{rank, name, total}>',
   *   execute: function(input) {
   *     // Test implementation using ctx.describe, ctx.it, ctx.expect
   *     return ctx.mocha.run();
   *   }
   * };
   */

  class ToolTestRunner {
    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * List all available tool tests
     * @returns {Object} {success, tests: [{name, toolName, description, enabled, testCount}]}
     */
    static listTests() {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const sheet = ss.getSheetByName('_Tests');
      if (!sheet) {
        return { success: true, tests: [], message: 'No _Tests sheet found' };
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        return { success: true, tests: [], message: 'No tests defined' };
      }

      // Map headers
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const descIdx = headers.indexOf('description');
      const enabledIdx = headers.indexOf('enabled');
      const toolNameIdx = headers.indexOf('tool_name');
      const examplesIdx = headers.indexOf('examples');

      const tests = [];
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][nameIdx] || '').trim();
        if (!name) continue;

        const enabledCell = data[i][enabledIdx];
        const enabled = enabledCell !== false &&
                        enabledCell !== 'FALSE' &&
                        String(enabledCell).toUpperCase() !== 'FALSE';

        // Try to count examples
        let testCount = 0;
        try {
          const examples = data[i][examplesIdx];
          if (examples) {
            const parsed = typeof examples === 'string' ? JSON.parse(examples) : examples;
            if (Array.isArray(parsed)) {
              testCount = parsed.length;
            }
          }
        } catch (e) {
          // Ignore parse errors
        }

        tests.push({
          name: name,
          toolName: String(data[i][toolNameIdx] || '').trim(),
          description: String(data[i][descIdx] || '').trim(),
          enabled: enabled,
          testCount: testCount,
          row: i + 1
        });
      }

      return { success: true, tests: tests };
    }

    /**
     * Get tests for a specific tool (for LLM context)
     * @param {string} toolName - Tool name to get tests for
     * @returns {Object} {success, toolName, tests, examples, expects}
     */
    static getTestsForTool(toolName) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const sheet = ss.getSheetByName('_Tests');
      if (!sheet) {
        return { success: false, error: 'No _Tests sheet found' };
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        return { success: false, error: 'No tests defined' };
      }

      // Map headers
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const descIdx = headers.indexOf('description');
      const toolNameIdx = headers.indexOf('tool_name');
      const examplesIdx = headers.indexOf('examples');
      const expectsIdx = headers.indexOf('expects');
      const implIdx = headers.indexOf('implementation');

      // Find tests for this tool
      const matchingTests = [];
      let examples = [];
      let expects = '';

      for (let i = 1; i < data.length; i++) {
        const rowToolName = String(data[i][toolNameIdx] || '').trim();
        if (rowToolName !== toolName) continue;

        const name = String(data[i][nameIdx] || '').trim();
        const description = String(data[i][descIdx] || '').trim();

        // Parse examples
        try {
          const examplesStr = data[i][examplesIdx];
          if (examplesStr) {
            const parsed = typeof examplesStr === 'string' ? JSON.parse(examplesStr) : examplesStr;
            if (Array.isArray(parsed)) {
              examples = examples.concat(parsed);
            }
          }
        } catch (e) {
          Logger.log(`[ToolTestRunner] Error parsing examples for ${name}: ${e.message}`);
        }

        // Capture expects
        if (data[i][expectsIdx]) {
          expects = String(data[i][expectsIdx]);
        }

        matchingTests.push({
          name: name,
          description: description
        });
      }

      if (matchingTests.length === 0) {
        return { success: false, error: `No tests found for tool '${toolName}'` };
      }

      return {
        success: true,
        toolName: toolName,
        tests: matchingTests,
        examples: examples,
        expects: expects,
        testCount: matchingTests.length
      };
    }

    /**
     * Get test metadata for LLM context
     * @param {string} testName - Test name
     * @returns {Object} {success, examples, expects, description}
     */
    static getTestMetadata(testName) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const sheet = ss.getSheetByName('_Tests');
      if (!sheet) {
        return { success: false, error: 'No _Tests sheet found' };
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        return { success: false, error: 'No tests defined' };
      }

      // Map headers
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const descIdx = headers.indexOf('description');
      const examplesIdx = headers.indexOf('examples');
      const expectsIdx = headers.indexOf('expects');
      const toolNameIdx = headers.indexOf('tool_name');

      // Find the test
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][nameIdx] || '').trim();
        if (name !== testName) continue;

        let examples = [];
        try {
          const examplesStr = data[i][examplesIdx];
          if (examplesStr) {
            examples = typeof examplesStr === 'string' ? JSON.parse(examplesStr) : examplesStr;
          }
        } catch (e) {
          Logger.log(`[ToolTestRunner] Error parsing examples for ${name}: ${e.message}`);
        }

        return {
          success: true,
          name: name,
          toolName: String(data[i][toolNameIdx] || '').trim(),
          description: String(data[i][descIdx] || '').trim(),
          examples: Array.isArray(examples) ? examples : [],
          expects: String(data[i][expectsIdx] || '')
        };
      }

      return { success: false, error: `Test '${testName}' not found` };
    }

    /**
     * Run a specific test
     * @param {string} testName - Test name to run
     * @param {Object} options - Run options
     * @returns {Object} {success, passed, failed, skipped, results, duration}
     */
    static runTest(testName, options = {}) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const sheet = ss.getSheetByName('_Tests');
      if (!sheet) {
        return { success: false, error: 'No _Tests sheet found' };
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        return { success: false, error: 'No tests defined' };
      }

      // Map headers
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const implIdx = headers.indexOf('implementation');
      const enabledIdx = headers.indexOf('enabled');

      // Find the test
      let testImpl = null;
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][nameIdx] || '').trim();
        if (name !== testName) continue;

        const enabledCell = data[i][enabledIdx];
        const enabled = enabledCell !== false &&
                        enabledCell !== 'FALSE' &&
                        String(enabledCell).toUpperCase() !== 'FALSE';

        if (!enabled && !options.force) {
          return { success: false, error: `Test '${testName}' is disabled` };
        }

        testImpl = String(data[i][implIdx] || '').trim();
        break;
      }

      if (!testImpl) {
        return { success: false, error: `Test '${testName}' not found` };
      }

      // Execute the test
      const startTime = Date.now();
      try {
        const result = this._executeTest(testImpl, testName, options);
        const duration = Date.now() - startTime;

        return {
          success: true,
          testName: testName,
          passed: result.passed || 0,
          failed: result.failed || 0,
          skipped: result.skipped || 0,
          results: result.results || [],
          duration: duration,
          output: result.output || ''
        };
      } catch (e) {
        const duration = Date.now() - startTime;
        Logger.log(`[ToolTestRunner] Test '${testName}' failed: ${e.message}`);
        return {
          success: false,
          testName: testName,
          error: e.message,
          stack: e.stack,
          duration: duration
        };
      }
    }

    /**
     * Run all tests for a specific tool
     * @param {string} toolName - Tool name
     * @param {Object} options - Run options
     * @returns {Object} {success, toolName, totalPassed, totalFailed, testResults}
     */
    static runToolTests(toolName, options = {}) {
      const testsResult = this.getTestsForTool(toolName);
      if (!testsResult.success) {
        return testsResult;
      }

      const testResults = [];
      let totalPassed = 0;
      let totalFailed = 0;
      let totalSkipped = 0;

      for (const test of testsResult.tests) {
        const result = this.runTest(test.name, options);
        testResults.push(result);

        if (result.success) {
          totalPassed += result.passed || 0;
          totalFailed += result.failed || 0;
          totalSkipped += result.skipped || 0;
        } else {
          totalFailed++;
        }
      }

      return {
        success: totalFailed === 0,
        toolName: toolName,
        totalPassed: totalPassed,
        totalFailed: totalFailed,
        totalSkipped: totalSkipped,
        testResults: testResults
      };
    }

    /**
     * Run all enabled tests
     * @param {Object} options - Run options
     * @returns {Object} {success, totalPassed, totalFailed, testResults}
     */
    static runAllTests(options = {}) {
      const listResult = this.listTests();
      if (!listResult.success) {
        return listResult;
      }

      const testResults = [];
      let totalPassed = 0;
      let totalFailed = 0;
      let totalSkipped = 0;

      for (const test of listResult.tests) {
        if (!test.enabled && !options.force) {
          totalSkipped++;
          continue;
        }

        const result = this.runTest(test.name, options);
        testResults.push(result);

        if (result.success) {
          totalPassed += result.passed || 0;
          totalFailed += result.failed || 0;
          totalSkipped += result.skipped || 0;
        } else {
          totalFailed++;
        }
      }

      return {
        success: totalFailed === 0,
        totalPassed: totalPassed,
        totalFailed: totalFailed,
        totalSkipped: totalSkipped,
        testResults: testResults
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Execute test implementation
     * @private
     */
    static _executeTest(implementation, testName, options) {
      const ModuleLoader = require('tools/ModuleLoader');

      // Build simple test context with minimal mocha-like interface
      const testResults = [];
      let currentDescribe = '';

      const describe = (name, fn) => {
        currentDescribe = name;
        try {
          fn();
        } catch (e) {
          testResults.push({
            describe: currentDescribe,
            it: '(describe block failed)',
            passed: false,
            error: e.message
          });
        }
        currentDescribe = '';
      };

      const it = (name, fn) => {
        try {
          fn();
          testResults.push({
            describe: currentDescribe,
            it: name,
            passed: true
          });
        } catch (e) {
          testResults.push({
            describe: currentDescribe,
            it: name,
            passed: false,
            error: e.message
          });
        }
      };

      // Simple expect implementation
      const expect = (actual) => ({
        toBe: (expected) => {
          if (actual !== expected) {
            throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
          }
        },
        toEqual: (expected) => {
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
          }
        },
        toBeTruthy: () => {
          if (!actual) {
            throw new Error(`Expected truthy value but got ${JSON.stringify(actual)}`);
          }
        },
        toBeFalsy: () => {
          if (actual) {
            throw new Error(`Expected falsy value but got ${JSON.stringify(actual)}`);
          }
        },
        toBeNull: () => {
          if (actual !== null) {
            throw new Error(`Expected null but got ${JSON.stringify(actual)}`);
          }
        },
        toBeUndefined: () => {
          if (actual !== undefined) {
            throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
          }
        },
        toContain: (item) => {
          if (Array.isArray(actual)) {
            if (!actual.includes(item)) {
              throw new Error(`Expected array to contain ${JSON.stringify(item)}`);
            }
          } else if (typeof actual === 'string') {
            if (!actual.includes(item)) {
              throw new Error(`Expected string to contain ${JSON.stringify(item)}`);
            }
          } else {
            throw new Error('toContain requires array or string');
          }
        },
        toHaveLength: (length) => {
          if (!Array.isArray(actual) && typeof actual !== 'string') {
            throw new Error('toHaveLength requires array or string');
          }
          if (actual.length !== length) {
            throw new Error(`Expected length ${length} but got ${actual.length}`);
          }
        },
        toThrow: (errorMatcher) => {
          if (typeof actual !== 'function') {
            throw new Error('toThrow requires a function');
          }
          let threw = false;
          let thrownError = null;
          try {
            actual();
          } catch (e) {
            threw = true;
            thrownError = e;
          }
          if (!threw) {
            throw new Error('Expected function to throw');
          }
          if (errorMatcher && thrownError.message.indexOf(errorMatcher) === -1) {
            throw new Error(`Expected error message to contain '${errorMatcher}' but got '${thrownError.message}'`);
          }
        }
      });

      // Simple mocha result aggregator
      const mocha = {
        run: () => {
          const passed = testResults.filter(r => r.passed).length;
          const failed = testResults.filter(r => !r.passed).length;
          return {
            passed,
            failed,
            skipped: 0,
            results: testResults,
            output: testResults.map(r =>
              `${r.passed ? '✓' : '✗'} ${r.describe ? r.describe + ': ' : ''}${r.it}${r.error ? ' - ' + r.error : ''}`
            ).join('\n')
          };
        }
      };

      // Build ctx with test utilities
      const ctx = {
        // Test utilities
        describe,
        it,
        expect,
        mocha,

        // GAS services
        SpreadsheetApp,
        ScriptApp,
        UrlFetchApp,
        DriveApp,
        GmailApp,
        DocumentApp,
        SlidesApp,
        CalendarApp,
        FormApp,
        CacheService,
        PropertiesService,
        Utilities,
        Logger,
        Session,
        HtmlService,
        ContentService,
        LockService,

        // Helpers
        log: (msg) => Logger.log(msg),
        thinking: (msg) => Logger.log(`[THINKING] ${msg}`),

        // Require for accessing other modules
        require: (moduleName) => {
          try {
            return globalThis.require ? globalThis.require(moduleName) : null;
          } catch (e) {
            Logger.log(`[ctx.require] Failed to load '${moduleName}': ${e.message}`);
            return null;
          }
        }
      };

      // Check if implementation is module style
      const isModule = /module\.exports\s*=/.test(implementation);

      if (isModule) {
        // Execute as module
        const loadResult = ModuleLoader.loadModule(implementation, ctx);
        if (!loadResult.success) {
          throw new Error(`Module load failed: ${loadResult.error}`);
        }

        const moduleExports = loadResult.exports;
        if (typeof moduleExports.execute === 'function') {
          return moduleExports.execute({});
        } else {
          // If no execute, just return module loading success
          return { passed: 1, failed: 0, results: [{ it: 'Module loaded successfully', passed: true }] };
        }
      } else {
        // Execute as bare code with ctx injected
        const fn = new Function(
          'ctx', 'describe', 'it', 'expect', 'mocha',
          `${implementation}; return mocha.run();`
        );

        return fn(ctx, describe, it, expect, mocha);
      }
    }
  }

  module.exports = ToolTestRunner;
}

__defineModule__(_main);