function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Ad Hoc Claude Verification Tests for USAW Dynamic Tools
   * 
   * Manual verification scenarios for testing with Claude API.
   * These functions can be run individually to verify tool discovery and invocation.
   * 
   * Cost estimate: ~$0.15 per full run
   */

  /**
   * Verify that Claude can discover all 4 USAW dynamic tools
   * Run this to confirm tools are properly registered and visible to Claude
   */
  function verifyToolDiscovery() {
    var ToolRegistry = require('tools/ToolRegistry');
    var registry = new ToolRegistry({ enableDynamicTools: true });
    var tools = registry.getEnabledTools();
    
    var usawTools = tools.filter(function(t) {
      return t.name.startsWith('usaw_') || t.name === 'iwf_events';
    });
    
    Logger.log('=== TOOL DISCOVERY VERIFICATION ===');
    Logger.log('Total tools in registry: ' + tools.length);
    Logger.log('USAW tools found: ' + usawTools.length);
    Logger.log('');
    
    usawTools.forEach(function(t) {
      Logger.log('Tool: ' + t.name);
      Logger.log('  Description: ' + t.description.substring(0, 100) + '...');
      Logger.log('  Parameters: ' + JSON.stringify(Object.keys(t.input_schema.properties || {})));
      Logger.log('  Required: ' + JSON.stringify(t.input_schema.required || []));
      Logger.log('');
    });
    
    Logger.log('=== END ===');
    
    return {
      totalTools: tools.length,
      usawToolCount: usawTools.length,
      usawTools: usawTools.map(function(t) { return t.name; }),
      expectedCount: 4,
      discovery: usawTools.length === 4 ? 'PASS' : 'FAIL'
    };
  }

  /**
   * Test prompts that should trigger specific USAW tools
   * Returns test scenarios for manual verification with Claude
   */
  function getTestScenarios() {
    var scenarios = [
      {
        prompt: 'What weight classes are available for USAW competitions?',
        expectedTool: 'usaw_filter_options',
        expectedAction: 'Returns filter metadata for weight classes'
      },
      {
        prompt: 'Show me the WSO records for Pacific Weightlifting',
        expectedTool: 'usaw_wso_records',
        expectedAction: 'Fetches records from Pacific WSO'
      },
      {
        prompt: 'What IWF international weightlifting events are happening in 2024?',
        expectedTool: 'iwf_events',
        expectedAction: 'Scrapes IWF calendar for 2024 events'
      },
      {
        prompt: 'Get the results from USAW event 12345',
        expectedTool: 'usaw_event_results',
        expectedAction: 'Fetches results for specific event ID'
      },
      {
        prompt: 'List all available age groups and divisions in USAW',
        expectedTool: 'usaw_filter_options',
        expectedAction: 'Returns filter metadata for age groups/divisions'
      }
    ];
    
    Logger.log('=== TEST SCENARIOS FOR CLAUDE ===');
    scenarios.forEach(function(s, i) {
      Logger.log('');
      Logger.log('Scenario ' + (i + 1) + ':');
      Logger.log('  Prompt: "' + s.prompt + '"');
      Logger.log('  Expected Tool: ' + s.expectedTool);
      Logger.log('  Expected Action: ' + s.expectedAction);
    });
    Logger.log('');
    Logger.log('=== END ===');
    
    return scenarios;
  }

  /**
   * Execute a single tool call and log results
   * Use this for quick manual verification
   * 
   * @param {string} toolName - Name of the tool to test
   * @param {Object} params - Parameters to pass to the tool
   */
  function testToolExecution(toolName, params) {
    var ToolRegistry = require('tools/ToolRegistry');
    var registry = new ToolRegistry({ enableDynamicTools: true });
    
    Logger.log('=== MANUAL TOOL EXECUTION TEST ===');
    Logger.log('Tool: ' + toolName);
    Logger.log('Params: ' + JSON.stringify(params));
    Logger.log('');
    
    var startTime = Date.now();
    var result = registry.executeToolCall(toolName, params || {}, {});
    var duration = Date.now() - startTime;
    
    Logger.log('Duration: ' + duration + 'ms');
    Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
    
    if (result.success) {
      var resultStr = JSON.stringify(result.result);
      if (resultStr.length > 500) {
        resultStr = resultStr.substring(0, 500) + '...[truncated]';
      }
      Logger.log('Result: ' + resultStr);
    } else {
      Logger.log('Error: ' + result.error);
    }
    
    Logger.log('=== END ===');
    
    return result;
  }

  /**
   * Quick test of filter_options tool (no API token needed)
   */
  function testFilterOptions() {
    return testToolExecution('usaw_filter_options', {});
  }

  /**
   * Quick test of WSO records tool
   */
  function testWsoRecords() {
    return testToolExecution('usaw_wso_records', { wso: 'Pacific Weightlifting' });
  }

  /**
   * Quick test of IWF events tool
   */
  function testIwfEvents() {
    return testToolExecution('iwf_events', { year: 2024 });
  }

  /**
   * Quick test of event results tool
   */
  function testEventResults() {
    return testToolExecution('usaw_event_results', { event_id: '12345' });
  }

  /**
   * Run all quick tests in sequence
   * Returns summary of results
   */
  function runAllQuickTests() {
    Logger.log('=== RUNNING ALL QUICK TESTS ===');
    Logger.log('');
    
    var results = {
      discovery: verifyToolDiscovery(),
      filterOptions: null,
      wsoRecords: null,
      iwfEvents: null,
      eventResults: null
    };
    
    // Test each tool (some may fail if external APIs are down)
    try {
      results.filterOptions = { success: testFilterOptions().success };
    } catch (e) {
      results.filterOptions = { success: false, error: e.message };
    }
    
    try {
      results.wsoRecords = { success: testWsoRecords().success };
    } catch (e) {
      results.wsoRecords = { success: false, error: e.message };
    }
    
    try {
      results.iwfEvents = { success: testIwfEvents().success };
    } catch (e) {
      results.iwfEvents = { success: false, error: e.message };
    }
    
    try {
      results.eventResults = { success: testEventResults().success };
    } catch (e) {
      results.eventResults = { success: false, error: e.message };
    }
    
    Logger.log('');
    Logger.log('=== SUMMARY ===');
    Logger.log('Tool Discovery: ' + results.discovery.discovery);
    Logger.log('filter_options: ' + (results.filterOptions.success ? 'PASS' : 'FAIL'));
    Logger.log('wso_records: ' + (results.wsoRecords.success ? 'PASS' : 'FAIL'));
    Logger.log('iwf_events: ' + (results.iwfEvents.success ? 'PASS' : 'FAIL'));
    Logger.log('event_results: ' + (results.eventResults.success ? 'PASS' : 'FAIL'));
    Logger.log('=== END ===');
    
    return results;
  }

  /**
   * Generate Claude conversation test prompts
   * Copy these prompts to test with the actual Claude conversation
   */
  function generateClaudeTestPrompts() {
    var prompts = [
      '### Test 1: Tool Discovery',
      'Ask Claude: "What weightlifting tools do you have available?"',
      'Expected: Claude should mention usaw_filter_options, usaw_wso_records, iwf_events, usaw_event_results',
      '',
      '### Test 2: Filter Options Invocation',
      'Ask Claude: "What weight classes are available for USAW competitions?"',
      'Expected: Claude should invoke usaw_filter_options tool',
      '',
      '### Test 3: WSO Records Invocation',
      'Ask Claude: "Show me the WSO records for Pacific Weightlifting"',
      'Expected: Claude should invoke usaw_wso_records with wso="Pacific Weightlifting"',
      '',
      '### Test 4: IWF Events Invocation',
      'Ask Claude: "What IWF events are scheduled for 2024?"',
      'Expected: Claude should invoke iwf_events with year=2024',
      '',
      '### Test 5: Event Results Invocation',
      'Ask Claude: "Get the results from USAW event 12345"',
      'Expected: Claude should invoke usaw_event_results with event_id=12345',
      '',
      '### Test 6: Natural Language Variation',
      'Ask Claude: "I want to know what competitions IWF has next year"',
      'Expected: Claude should invoke iwf_events tool with current year + 1',
      '',
      '### Test 7: Parameter Inference',
      'Ask Claude: "Who won the 73kg class at event 54321?"',
      'Expected: Claude should invoke usaw_event_results with event_id=54321'
    ];
    
    Logger.log(prompts.join('\n'));
    
    return prompts;
  }

  module.exports = {
    verifyToolDiscovery: verifyToolDiscovery,
    getTestScenarios: getTestScenarios,
    testToolExecution: testToolExecution,
    testFilterOptions: testFilterOptions,
    testWsoRecords: testWsoRecords,
    testIwfEvents: testIwfEvents,
    testEventResults: testEventResults,
    runAllQuickTests: runAllQuickTests,
    generateClaudeTestPrompts: generateClaudeTestPrompts
  };
}

__defineModule__(_main);