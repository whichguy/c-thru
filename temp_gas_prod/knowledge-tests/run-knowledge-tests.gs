function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Knowledge Tests Runner
   * 
   * Loads and executes all knowledge-related test files.
   * Uses mocha-adapter for test organization and execution.
   */

  function runKnowledgeTests() {
    const mocha = require('test-framework/mocha-adapter');
    mocha.resetContext();

    // Load all knowledge test files
    [
      'knowledge-tests/Knowledge.unit.test',
      'knowledge-tests/Knowledge.integration.test',
      'knowledge-tests/Knowledge.e2e.test',
      'knowledge-tests/Tools.e2e.test',  // New: E2E tests for all _Tools functions
      'knowledge-tests/USAW-Tools.unit.test',
      'knowledge-tests/USAW-Tools.integration.test',
      'knowledge-tests/USAW-Prompt.test',
      'knowledge-tests/USAW-API.contract.test',
      'knowledge-tests/USAW-Filter.contract.test',
      'knowledge-tests/IWF-Endpoint.contract.test'
    ].forEach(f => require(f));

    const results = mocha.executeAll();
    const summary = mocha.getSummary(results);

    Logger.log('Knowledge Tests: ' + summary.passed + '/' + summary.total + ' passed');
    
    // Log detailed results if any failures
    if (summary.failed > 0) {
      Logger.log(mocha.formatResults(results));
    }
    
    return summary;
  }

  /**
   * Run only the tool-specific E2E tests
   * Use this for focused testing of _Tools sheet functions
   * Cost: ~$0.14 per run
   */
  function runToolsE2ETests() {
    const mocha = require('test-framework/mocha-adapter');
    mocha.resetContext();

    require('knowledge-tests/Tools.e2e.test');

    const results = mocha.executeAll();
    const summary = mocha.getSummary(results);

    Logger.log('Tools E2E Tests: ' + summary.passed + '/' + summary.total + ' passed');
    
    if (summary.failed > 0) {
      Logger.log(mocha.formatResults(results));
    }
    
    return summary;
  }

  module.exports = { runKnowledgeTests, runToolsE2ETests };
}

__defineModule__(_main);