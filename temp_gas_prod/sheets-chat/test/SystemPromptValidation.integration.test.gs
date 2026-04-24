function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * System Prompt Validation - USAW Data Insertion Integration Tests
   * 
   * PURPOSE: Validate system prompt changes by testing Claude's ability to interpret
   * natural language prompts and correctly insert weightlifting data into Google Sheets.
   * 
   * These tests serve as regression/acceptance tests when modifying SystemPrompt.gs
   * 
   * USAGE: Run via test framework:
   *   require('test-framework/test-runner').runRepoTests('sheets-chat')
   */

  const { describe, it, before, beforeEach, afterEach, after } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const ClaudeConversation = require('sheets-chat/ClaudeConversation');

  describe('System Prompt Validation - USAW Data Insertion', () => {
    const ctx = {
      ss: null,
      testSheet: null,
      testSheetName: '',
      conversation: null,
      results: [],  // Capture results for comparison
      keepSheets: true,  // Set to false to auto-delete test sheets after each test
      currentTestIndex: 0,  // Track which test is running
      testAbbreviations: ['JrW69', 'YouthNat', 'WtClasses', 'IWFWomen', 'Upcoming', 'RegAthletes', 'HistMeets', 'MeetRes']
    };

    before(() => {
      ctx.ss = SpreadsheetApp.getActiveSpreadsheet();
      ctx.conversation = new ClaudeConversation();
      Logger.log('[SETUP] Testing with current SystemPrompt.gs');
      Logger.log('[SETUP] Model: ' + ctx.conversation.model);
    });

    beforeEach(() => {
      // Create unique temp sheet per test using abbreviation
      const abbrev = ctx.testAbbreviations[ctx.currentTestIndex] || 'Test' + ctx.currentTestIndex;
      ctx.testSheetName = 'TEST_' + abbrev + '_' + Date.now();
      ctx.currentTestIndex++;
      ctx.testSheet = ctx.ss.insertSheet(ctx.testSheetName);
      ctx.testSheet.activate();
      Logger.log('[SETUP] Created test sheet: ' + ctx.testSheetName);
    });

    afterEach(() => {
      // Capture sheet data before cleanup for analysis
      if (ctx.testSheet) {
        try {
          const data = ctx.testSheet.getDataRange().getValues();
          ctx.results.push({
            sheet: ctx.testSheetName,
            rows: data.length,
            cols: data[0]?.length || 0,
            headers: data[0] || [],
            sampleRow: data[1] || []
          });
        } catch (e) {
          Logger.log('[ERROR] Could not capture test data: ' + e.message + ' - stack: ' + (e.stack || 'none'));
        }

        if (!ctx.keepSheets) {
          try {
            ctx.ss.deleteSheet(ctx.testSheet);
          } catch (e) {
            Logger.log('[ERROR] Could not delete test sheet: ' + e.message + ' - stack: ' + (e.stack || 'none'));
          }
        } else {
          Logger.log('[KEEP] Sheet preserved for validation: ' + ctx.testSheetName);
        }
        ctx.testSheet = null;
      }
    });
    
    after(() => {
      // Reset test index and log summary
      ctx.currentTestIndex = 0;
      Logger.log('[SUMMARY] Test Results:');
      ctx.results.forEach((r, i) => {
        Logger.log(`  [${i + 1}] ${r.sheet}: ${r.rows} rows x ${r.cols} cols`);
        Logger.log(`      Headers: ${r.headers.slice(0, 5).join(', ')}${r.headers.length > 5 ? '...' : ''}`);
      });
    });

    /**
     * Send prompt to Claude and wait for completion
     * Returns structured result for validation
     * Captures exec code for comparison across system prompt versions
     */
    function sendPromptAndWait(prompt) {
      const startTime = Date.now();

      try {
        const response = ctx.conversation.sendMessage({
          messages: [],
          text: prompt,
          context: { depth: 0 }
        });

        const elapsed = Date.now() - startTime;

        // Extract exec code from tool uses for comparison
        const execCodes = (response.toolUses || [])
          .filter(tu => tu.name === 'exec')
          .map(tu => tu.input?.jsCode || '');

        // Log exec code for system prompt comparison
        execCodes.forEach((code, i) => {
          Logger.log('[EXEC CODE #' + (i + 1) + ']');
          Logger.log(code);
          Logger.log('[/EXEC CODE]');
        });

        Logger.log('[PROMPT] "' + prompt + '" completed in ' + elapsed + 'ms');
        Logger.log('[TOOL USES] ' + (response.toolUses || []).length + ' tool calls');
        
        // Debug success calculation
        const success = !response.cancelled && !!response.response;
        Logger.log('[DEBUG] cancelled=' + response.cancelled + ', response.length=' + (response.response || '').length + ', success=' + success);

        return {
          success: success,
          response: response.response || '',
          toolUses: response.toolUses || [],
          execCodes: execCodes,  // Captured for comparison
          thinkingMessages: response.thinkingMessages || [],
          elapsed: elapsed,
          error: null
        };
      } catch (e) {
        Logger.log('[ERROR] ' + e.message);
        return {
          success: false,
          response: '',
          toolUses: [],
          execCodes: [],
          thinkingMessages: [],
          error: e.message,
          elapsed: Date.now() - startTime
        };
      }
    }

    /**
     * Validate that Claude explained empty results appropriately
     * Used when data source has no matching data
     */
    function validateExplanation(result) {
      const text = (result.response || '').toLowerCase();

      // Claude should explain why no data was found
      const explanationPatterns = [
        'no data',
        'not available',
        'no results',
        'could not find',
        'no records',
        'unavailable',
        'not yet published',
        'no matching',
        'empty',
        'nothing found',
        'unable to',
        "couldn't find",
        'doesn\'t appear',
        'does not appear'
      ];

      return explanationPatterns.some(pattern => text.includes(pattern));
    }

    // Test 1: Junior Women 69kg Rankings
    it('should insert junior women 69kg rankings', () => {
      const prompt = 'insert records for junior women 69kg';

      const result = sendPromptAndWait(prompt);

      // Validate Claude responded successfully
      expect(result.success, 'Claude should complete without error').to.be.true;

      // Validate sheet data (tools were executed if data exists)
      const data = ctx.testSheet.getDataRange().getValues();
      expect(data.length, 'Should have header + data rows').to.be.greaterThan(1);

      // Validate schema - should have ranking-related columns
      const headers = data[0].map(h => String(h).toLowerCase());
      const hasNameColumn = headers.some(h => h.includes('name') || h.includes('athlete') || h.includes('lifter'));
      const hasResultColumn = headers.some(h => h.includes('rank') || h.includes('total') || h.includes('snatch') || h.includes('clean'));

      expect(hasNameColumn, 'Should have athlete/name column').to.be.true;
      expect(hasResultColumn, 'Should have ranking/total column').to.be.true;

      // Validate weight class filter was applied (if weight class column exists)
      const wcCol = headers.findIndex(h => h.includes('weight') || h.includes('category'));
      if (wcCol >= 0) {
        const weightClasses = data.slice(1).map(r => String(r[wcCol]));
        const has69 = weightClasses.some(wc => wc.includes('69'));
        expect(has69, 'Data should contain 69kg weight class').to.be.true;
      }

      Logger.log('[RESULT] Rows: ' + data.length + ', Headers: ' + headers.join(', '));
    });

    // Test 2: Youth Nationals Results
    it('should insert 2025 youth nationals results or explain unavailability', () => {
      const prompt = 'insert results from 2025 usa weightlifting youth national championships';

      const result = sendPromptAndWait(prompt);
      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();

      // If data was inserted, validate schema
      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        const hasAthlete = headers.some(h => h.includes('name') || h.includes('athlete') || h.includes('lifter'));
        const hasResult = headers.some(h =>
          h.includes('total') || h.includes('result') ||
          h.includes('snatch') || h.includes('clean') ||
          h.includes('place') || h.includes('rank')
        );

        expect(hasAthlete, 'Should have athlete/name column').to.be.true;
        expect(hasResult, 'Should have result/total column').to.be.true;

        Logger.log('[RESULT] Found ' + (data.length - 1) + ' athletes');
      } else {
        // No data - validate Claude explained why
        const explained = validateExplanation(result);
        expect(explained, 'Claude should explain why no data was found').to.be.true;
        Logger.log('[EXPLANATION] Claude explained empty results: ' + result.response.substring(0, 200));
      }
    });

    // Test 3: Active Weight Classes
    it('should insert active weight classes', () => {
      const prompt = 'insert the active weight classes';

      const result = sendPromptAndWait(prompt);
      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      expect(data.length, 'Should have rows for weight classes').to.be.greaterThan(1);

      // Flatten and check for known weight classes
      const allValues = data.flat().map(v => String(v));

      // Current IWF weight classes
      const womenClasses = ['49', '55', '59', '64', '71', '76', '81', '87'];
      const menClasses = ['61', '67', '73', '81', '89', '96', '102', '109'];

      const foundWomen = womenClasses.filter(wc => allValues.some(v => v.includes(wc)));
      const foundMen = menClasses.filter(wc => allValues.some(v => v.includes(wc)));

      const totalFound = foundWomen.length + foundMen.length;
      expect(totalFound, 'Should have most weight classes (found: ' + totalFound + ')').to.be.greaterThan(8);

      Logger.log('[RESULT] Found weight classes - Women: ' + foundWomen.join(', ') + ' | Men: ' + foundMen.join(', '));
    });

    // Test 4: IWF Worlds Women
    it('should insert 2025 IWF worlds women results or explain unavailability', () => {
      const prompt = 'insert the 2025 IWF world championships for all women';

      const result = sendPromptAndWait(prompt);
      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();

      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());

        // Check for expected columns
        const hasAthlete = headers.some(h => h.includes('name') || h.includes('athlete') || h.includes('lifter'));
        expect(hasAthlete, 'Should have athlete column').to.be.true;

        // Check for gender column and verify women-only (if exists)
        const genderCol = headers.findIndex(h => h.includes('gender') || h.includes('sex'));
        if (genderCol >= 0) {
          const genders = data.slice(1).map(r => String(r[genderCol]).toLowerCase());
          const allWomen = genders.every(g =>
            g.includes('f') || g.includes('female') || g.includes('women') || g.includes('w') || g === ''
          );
          expect(allWomen, 'All results should be for women').to.be.true;
        }

        Logger.log('[RESULT] Found ' + (data.length - 1) + ' results');
      } else {
        // No data - validate Claude explained why
        const explained = validateExplanation(result);
        expect(explained, 'Claude should explain why no data was found').to.be.true;
        Logger.log('[EXPLANATION] Claude explained empty results: ' + result.response.substring(0, 200));
      }

      // Log exec code for system prompt comparison
      Logger.log('[EXEC CODES] ' + result.execCodes.length + ' exec blocks generated');
    });

    // Test 5: Upcoming Events (Future Events List)
    it('should show upcoming weightlifting events', () => {
      const prompt = 'show upcoming weightlifting events';
      const result = sendPromptAndWait(prompt);

      // Log full response (no trimming!)
      Logger.log('[RESPONSE] ' + result.response);

      expect(result.success, 'Claude should complete').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      expect(data.length, 'Should have events').to.be.greaterThan(1);
      expect(data.length, 'Should have at least 50 events').to.be.greaterThan(50);

      const headers = data[0].map(h => String(h).toLowerCase());
      expect(headers.some(h => h.includes('name') || h.includes('event')), 'Has name').to.be.true;
      expect(headers.some(h => h.includes('date') || h.includes('start')), 'Has date').to.be.true;

      Logger.log('[RESULT] ' + (data.length - 1) + ' upcoming events');
      Logger.log('[HEADERS] ' + headers.join(', '));
    });

    // Test 6: Registered Athletes or Meet Results (From Upcoming/Historical Event)
    // Note: If event not in upcoming events, Claude may find historical meet results instead
    it('should show registered athletes for upcoming event', () => {
      const prompt = 'show registered athletes for american open finals';
      const result = sendPromptAndWait(prompt);

      // Log full response (no trimming!)
      Logger.log('[RESPONSE] ' + result.response);

      expect(result.success, 'Claude should complete').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        Logger.log('[HEADERS] ' + headers.join(', '));
        
        // Accept either entry list (name/first/athlete) OR meet results (lifter)
        const hasName = headers.some(h => 
          h.includes('name') || h.includes('first') || h.includes('athlete') || h.includes('lifter')
        );
        expect(hasName, 'Has name/lifter column: ' + headers.join(', ')).to.be.true;
        
        // Accept either weight class (entry list) OR body weight/total (meet results)
        const hasWeightOrResult = headers.some(h => 
          h.includes('weight') || h.includes('class') || h.includes('total') || h.includes('snatch')
        );
        expect(hasWeightOrResult, 'Has weight/class/result column: ' + headers.join(', ')).to.be.true;
        
        Logger.log('[RESULT] ' + (data.length - 1) + ' athletes/results');
      } else {
        Logger.log('[NO DATA] Checking for explanation...');
        expect(validateExplanation(result), 'Should explain no data').to.be.true;
        Logger.log('[EXPLANATION] ' + result.response);
      }
    });

    // Test 7: Historical Meets (Past Events List)
    // NOTE: Prompt explicitly says "historical" to trigger rankings/events API instead of upcoming widget
    it('should insert historical usaw meets from january 2025', () => {
      const prompt = 'insert historical usaw meets from january 2025';
      const result = sendPromptAndWait(prompt);

      // Log full response (no trimming!)
      Logger.log('[RESPONSE] ' + result.response);

      expect(result.success, 'Claude should complete').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      expect(data.length, 'Should have meets').to.be.greaterThan(1);
      expect(data.length, 'Should have at least 20 meets from January 2025').to.be.greaterThan(20);

      const headers = data[0].map(h => String(h).toLowerCase());
      expect(headers.some(h => h.includes('meet') || h.includes('event') || h.includes('name')), 'Has meet').to.be.true;

      Logger.log('[RESULT] ' + (data.length - 1) + ' historical meets');
      Logger.log('[HEADERS] ' + headers.join(', '));
    });

    // Test 8: Meet Results (From Historical Event)
    // NOTE: Claude may create a new sheet instead of using the test sheet - we check both
    it('should show results from american open 2025', () => {
      const prompt = 'show results from american open 2025';
      const result = sendPromptAndWait(prompt);

      // Log full response (no trimming!)
      Logger.log('[RESPONSE] ' + result.response);

      expect(result.success, 'Claude should complete').to.be.true;

      // Check active test sheet first
      let data = ctx.testSheet.getDataRange().getValues();
      
      // Fallback: If test sheet is empty, search for recently created sheets with matching data
      if (data.length <= 1) {
        Logger.log('[FALLBACK] Test sheet empty, searching for new sheets with meet results...');
        const sheets = ctx.ss.getSheets();
        for (const sheet of sheets) {
          const name = sheet.getName();
          if (name.toLowerCase().includes('american') || name.toLowerCase().includes('open')) {
            const sheetData = sheet.getDataRange().getValues();
            if (sheetData.length > 10) {
              Logger.log('[FALLBACK] Found data in sheet: ' + name + ' (' + sheetData.length + ' rows)');
              data = sheetData;
              break;
            }
          }
        }
      }
      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        expect(headers.some(h => h.includes('lifter') || h.includes('name') || h.includes('athlete')), 'Has lifter').to.be.true;
        expect(headers.some(h => h.includes('total') || h.includes('snatch') || h.includes('clean')), 'Has lift data').to.be.true;
        expect(data.length, 'Should have at least 10 lifters').to.be.greaterThan(10);
        Logger.log('[RESULT] ' + (data.length - 1) + ' meet results');
        Logger.log('[HEADERS] ' + headers.join(', '));
      } else {
        Logger.log('[NO DATA] Checking for explanation...');
        expect(validateExplanation(result), 'Should explain no data').to.be.true;
        Logger.log('[EXPLANATION] ' + result.response);
      }
    });
  });

  /**
   * Run a specific test by number (1-4) or all tests
   * @param {number|null} testNum - Test number (1-4) or null/0 for all
   * @returns {Object} Test results and summary
   */
  function runTest(testNum) {
    const { executeAll, formatResults, getSummary, getContext, resetContext } = require('test-framework/mocha-adapter');
    
    // Check if tests are already registered
    let ctx = getContext();
    
    // If no tests registered yet, we need to force re-registration
    // This happens on first call when module was required but describe() didn't run yet
    if (!ctx.rootSuites || ctx.rootSuites.length === 0) {
      // Clear require cache and re-require to register tests
      resetContext();
      delete globalThis.__modules__?.['sheets-chat/test/SystemPromptValidation.integration.test'];
      require('sheets-chat/test/SystemPromptValidation.integration.test');
      ctx = getContext();
    }
    
    const suite = ctx.rootSuites[0];
    
    if (!suite) {
      return { error: 'No test suite found. Tests may not be registered properly.' };
    }
    
    // Filter to specific test if requested
    const allTests = [...suite.tests];
    if (testNum && testNum >= 1 && testNum <= allTests.length) {
      suite.tests = [allTests[testNum - 1]];
      // Set test index so beforeEach uses correct abbreviation
      // Access parent suite's ctx via closure - it was captured when describe() ran
      Logger.log('[RUN TEST] Running test #' + testNum + ': ' + allTests[testNum - 1].name);
    } else if (testNum) {
      return { error: 'Invalid test number: ' + testNum + '. Valid range: 1-' + allTests.length };
    } else {
      Logger.log('[RUN TEST] Running all ' + allTests.length + ' tests');
    }
    
    const results = executeAll();
    const summary = getSummary(results);
    
    Logger.log('\n' + formatResults(results));
    Logger.log('Summary: ' + JSON.stringify(summary));
    
    // Restore tests for next run
    suite.tests = allTests;
    
    return {
      testName: testNum ? allTests[testNum - 1]?.name : 'All tests',
      results: results[0],
      summary: summary
    };
  }

  // Export for CommonJS
  module.exports = { runTest };
}

__defineModule__(_main);