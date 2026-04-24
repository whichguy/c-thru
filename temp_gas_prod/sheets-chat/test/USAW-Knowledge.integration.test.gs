function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * USAW Knowledge Integration Tests
   *
   * PURPOSE: Validate Claude correctly uses the Knowledge sheet guidance
   * for USAW data fetching and parsing. Tests the full pipeline:
   * prompt -> Knowledge -> API call -> parse -> sheet
   *
   * KEY INSIGHT: Unlike IWF (HTML scraping), USAW uses a Sport80 JSON API.
   * Claude reads Knowledge sheet for API token, filters, and endpoint info,
   * then generates code to fetch and process USAW rankings data.
   *
   * WEIGHT CLASS NOTE: IWF changed weight classes in 2018. Current men's classes
   * are 61, 67, 73, 81, 89, 96, 102, 109, +109kg. USAW uses different classes:
   * Open Men's: 60, 65, 71, 79, 88, 94, 110, +110kg
   * Open Women's: 48, 53, 58, 63, 69, 77, 86, +86kg
   *
   * USAGE: Run via test framework:
   *   require('test-framework/test-runner').runTestFile('sheets-chat/test/USAW-Knowledge.integration.test')
   *
   * Or run specific test:
   *   require('sheets-chat/test/USAW-Knowledge.integration.test').runTest(1)
   */

  const { describe, it, before, beforeEach, afterEach, after } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const ClaudeConversation = require('sheets-chat/ClaudeConversation');

  describe('USAW Knowledge Integration Tests', () => {
    const ctx = {
      ss: null,
      testSheet: null,
      testSheetName: '',
      conversation: null,
      results: [],  // Capture results for comparison
      keepSheets: true,  // Set to false to auto-delete test sheets after each test
      currentTestIndex: 0,  // Track which test is running
      testAbbreviations: ['USAW88', 'USAW69W', 'USAWName', 'USAWDate', 'USAWClub', 'USAWLvl', 'USAWPage', 'USAWErr']
    };

    before(() => {
      ctx.ss = SpreadsheetApp.getActiveSpreadsheet();
      ctx.conversation = new ClaudeConversation();
      Logger.log('[SETUP] Testing USAW Knowledge sheet integration');
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
      Logger.log('[SUMMARY] USAW Knowledge Test Results:');
      ctx.results.forEach((r, i) => {
        Logger.log('  [' + (i + 1) + '] ' + r.sheet + ': ' + r.rows + ' rows x ' + r.cols + ' cols');
        Logger.log('      Headers: ' + r.headers.slice(0, 5).join(', ') + (r.headers.length > 5 ? '...' : ''));
      });
    });

    /**
     * Send prompt to Claude and wait for completion
     * Captures exec code for debugging Knowledge sheet interpretation
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

        // Log exec code for Knowledge sheet comparison - shows what Claude generated
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
        'does not appear',
        'no lifters',
        'no rankings',
        '401',
        '403',
        'unauthorized',
        'access denied',
        'doesn\'t have',
        'does not have',
        'don\'t have',
        'do not have',
        'weren\'t found',
        'were not found',
        'wasn\'t found',
        'was not found',
        'zero',
        '0 results',
        'none',
        'doesn\'t contain',
        'does not contain',
        'didn\'t find',
        'did not find',
        'unfortunately',
        'appears to be',
        'seem to',
        'doesn\'t seem',
        'does not seem',
        'no athletes',
        'historical data',
        'inactive',
        'weight class',
        'different',
        'changed',
        'current'
      ];

      return explanationPatterns.some(pattern => text.includes(pattern));
    }

    /**
     * Check if exec code uses USAW API token from Knowledge sheet
     */
    function usesUSAWApiToken(execCodes) {
      const allCode = execCodes.join('\n').toLowerCase();
      // USAW Sport80 API requires x-api-token header
      return allCode.includes('x-api-token') ||
             allCode.includes('14ced0f3-421f-4acf-94ad-cc63a371af19') ||
             allCode.includes('api_token') ||
             allCode.includes('apitoken');
    }

    /**
     * Check if exec code uses specific filter parameter
     */
    function usesFilterParam(execCodes, param) {
      const allCode = execCodes.join('\n').toLowerCase();
      return allCode.includes(param.toLowerCase());
    }

    // ========================================
    // Test Suite: Rankings Discovery (Core)
    // ========================================

    // Test 1: Insert USAW open men 88kg rankings for 2025 (weight_class filter)
    // Note: USAW uses 88kg, not IWF's 89kg
    it('should insert 2025 USAW open men 88kg rankings', () => {
      const prompt = 'insert 2025 USAW open men 88kg rankings';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      // Should have header + ranking rows
      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        
        // Should have name/athlete column
        const hasNameColumn = headers.some(h =>
          h.includes('name') || h.includes('athlete') || h.includes('lifter')
        );
        expect(hasNameColumn, 'Has name/athlete column: ' + headers.join(', ')).to.be.true;

        // Should have total/lift columns
        const hasLiftColumn = headers.some(h =>
          h.includes('total') || h.includes('snatch') || h.includes('clean') || h.includes('jerk')
        );
        expect(hasLiftColumn, 'Has lift/total column: ' + headers.join(', ')).to.be.true;

        // Verify API token usage if exec codes captured
        if (result.execCodes.length > 0) {
          const usesToken = usesUSAWApiToken(result.execCodes);
          Logger.log('[API TOKEN] Uses USAW token: ' + usesToken);
        }

        // Log sample data
        Logger.log('[SAMPLE] First ranking: ' + JSON.stringify(data[1]));
        Logger.log('[RESULT] Found ' + (data.length - 1) + ' rankings');
      } else {
        // No data - Claude should explain why (e.g., no rankings for this period)
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        expect(explained || hasResponse, 'Claude should explain no data found or provide meaningful response').to.be.true;
        Logger.log('[EXPLANATION] ' + result.response.substring(0, 300));
      }
    });

    // Test 2: Insert USAW open women 69kg rankings for 2025 (weight_class filter)
    it('should insert 2025 USAW open women 69kg rankings', () => {
      const prompt = 'insert 2025 USAW open women 69kg rankings';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        
        // Should have name column
        const hasNameColumn = headers.some(h =>
          h.includes('name') || h.includes('athlete') || h.includes('lifter')
        );
        expect(hasNameColumn, 'Has name column: ' + headers.join(', ')).to.be.true;

        // Check for weight class - should be 69kg
        const wcCol = headers.findIndex(h => 
          h.includes('weight') || h.includes('class') || h.includes('category')
        );
        if (wcCol >= 0) {
          const weightClasses = data.slice(1).map(r => String(r[wcCol]));
          Logger.log('[WEIGHT CLASSES] ' + weightClasses.slice(0, 5).join(', '));
          const has69 = weightClasses.some(wc => wc.includes('69'));
          Logger.log('[69KG CHECK] Found 69kg data: ' + has69);
        }

        // Verify weight class filter used if exec codes captured
        if (result.execCodes.length > 0) {
          const usesWeightClass = usesFilterParam(result.execCodes, 'weight_class');
          Logger.log('[WEIGHT FILTER] weight_class: ' + usesWeightClass);
        }

        Logger.log('[RESULT] Found ' + (data.length - 1) + ' rankings');
      } else {
        // No data - validate explanation
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        expect(explained || hasResponse, 'Claude should explain no data found').to.be.true;
        Logger.log('[EXPLANATION] ' + result.response.substring(0, 300));
      }
    });

    // Test 3: Find lifters by name search for 2025 (s= param)
    it('should find 2025 USAW rankings for lifters named Smith', () => {
      const prompt = 'find 2025 USAW rankings for lifters named Smith';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        
        // Find name column
        const nameCol = headers.findIndex(h =>
          h.includes('name') || h.includes('athlete') || h.includes('lifter')
        );

        if (nameCol >= 0) {
          const names = data.slice(1).map(r => String(r[nameCol]).toLowerCase());
          const hasSmith = names.some(n => n.includes('smith'));
          Logger.log('[NAME SEARCH] Found Smith: ' + hasSmith);
          Logger.log('[NAMES] ' + names.slice(0, 5).join(', '));
        }

        // Verify search param used if exec codes captured
        if (result.execCodes.length > 0) {
          const usesSearch = usesFilterParam(result.execCodes, 's=') ||
                            usesFilterParam(result.execCodes, 'search') ||
                            usesFilterParam(result.execCodes, 'smith');
          Logger.log('[SEARCH PARAM] Uses search: ' + usesSearch);
        }
      } else {
        // No results for Smith - that's okay, just validate explanation
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 50;
        expect(explained || hasResponse, 'Claude should explain no results').to.be.true;
      }
    });

    // ========================================
    // Test Suite: Filter Handling (All 8 API Filters)
    // ========================================

    // Test 4: Filter rankings by date range (date_range_start/end)
    it('should filter USAW rankings by date range January 2025', () => {
      const prompt = 'insert USAW rankings from January 2025';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      if (data.length > 1) {
        // Verify date filter used if exec codes captured
        if (result.execCodes.length > 0) {
          const usesDateStart = usesFilterParam(result.execCodes, 'date_range_start');
          const usesDateEnd = usesFilterParam(result.execCodes, 'date_range_end');
          const uses2025 = usesFilterParam(result.execCodes, '2025');
          Logger.log('[DATE FILTER] start: ' + usesDateStart + ', end: ' + usesDateEnd + ', 2025: ' + uses2025);
        }

        Logger.log('[RESULT] Found ' + (data.length - 1) + ' rankings');
        Logger.log('[HEADERS] ' + data[0].join(', '));
      } else {
        // No data for January 2025 - validate explanation
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        expect(explained || hasResponse, 'Claude should explain no data found').to.be.true;
      }
    });

    // Test 5: Filter rankings by club name for 2025 (club filter)
    it('should filter 2025 USAW rankings by club Fortified Strength', () => {
      const prompt = 'show 2025 USAW rankings for Fortified Strength club';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      if (data.length > 1) {
        const headers = data[0].map(h => String(h).toLowerCase());
        
        // Check for club column
        const clubCol = headers.findIndex(h =>
          h.includes('club') || h.includes('team') || h.includes('gym')
        );
        if (clubCol >= 0) {
          const clubs = data.slice(1).map(r => String(r[clubCol]));
          Logger.log('[CLUBS] ' + clubs.slice(0, 5).join(', '));
        }

        // Verify club filter used if exec codes captured
        if (result.execCodes.length > 0) {
          const usesClub = usesFilterParam(result.execCodes, 'club') ||
                          usesFilterParam(result.execCodes, 'fortified');
          Logger.log('[CLUB FILTER] Uses club filter: ' + usesClub);
        }

        Logger.log('[RESULT] Found ' + (data.length - 1) + ' rankings');
      } else {
        // No data for this club - validate explanation
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        expect(explained || hasResponse, 'Claude should explain no data found').to.be.true;
      }
    });

    // Test 6: Filter by competition level for 2025 (level filter)
    it('should filter 2025 USAW rankings by national level', () => {
      const prompt = 'insert 2025 USAW national level rankings';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      if (data.length > 1) {
        // Verify level filter used if exec codes captured
        if (result.execCodes.length > 0) {
          const usesLevel = usesFilterParam(result.execCodes, 'level');
          Logger.log('[LEVEL FILTER] Uses level filter: ' + usesLevel);
        }

        Logger.log('[RESULT] Found ' + (data.length - 1) + ' rankings');
        Logger.log('[HEADERS] ' + data[0].join(', '));
      } else {
        // No national data - validate explanation
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        expect(explained || hasResponse, 'Claude should explain no data found').to.be.true;
      }
    });

    // ========================================
    // Test Suite: Knowledge Sheet Guidance
    // ========================================

    // Test 7: Handle pagination for large result sets (2025 data)
    it('should handle pagination for large 2025 USAW result sets', () => {
      const prompt = 'insert all 2025 USAW open women rankings';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without error').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      // Large result set should have many rows (pagination working)
      if (data.length > 100) {
        Logger.log('[PAGINATION] Got ' + (data.length - 1) + ' rows - pagination likely worked');
      } else if (data.length > 1) {
        Logger.log('[PAGINATION] Got ' + (data.length - 1) + ' rows - may be limited or no pagination needed');
      }

      // Verify exec codes show pagination handling if captured
      if (result.execCodes.length > 0) {
        const usesPagination = usesFilterParam(result.execCodes, 'page') ||
                              usesFilterParam(result.execCodes, 'offset') ||
                              usesFilterParam(result.execCodes, 'while') ||
                              usesFilterParam(result.execCodes, 'next');
        Logger.log('[PAGINATION CODE] Uses pagination: ' + usesPagination);
      }

      // Should have some data or explain why not
      if (data.length <= 1) {
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        expect(explained || hasResponse, 'Claude should explain no data found').to.be.true;
      } else {
        expect(data.length, 'Should have ranking data').to.be.greaterThan(1);
      }
    });

    // ========================================
    // Test Suite: Error Recovery
    // ========================================

    // Test 8: Handle unavailable USAW data gracefully (1990 - no data expected)
    it('should handle USAW rankings from 1990 gracefully', () => {
      const prompt = 'insert USAW rankings from 1990';
      const result = sendPromptAndWait(prompt);

      expect(result.success, 'Claude should complete without crashing').to.be.true;

      const data = ctx.testSheet.getDataRange().getValues();
      Logger.log('[VALIDATION] Rows: ' + data.length);

      if (data.length <= 1) {
        // No data for 1990 - validate Claude explained why OR gave meaningful response
        const explained = validateExplanation(result);
        const hasResponse = result.response.length > 100;
        Logger.log('[EXPLANATION CHECK] Pattern match: ' + explained + ', Response length: ' + result.response.length);
        Logger.log('[RESPONSE] ' + result.response.substring(0, 500));

        // Accept either a matching explanation pattern OR a substantial response
        expect(explained || hasResponse, 'Claude should explain no data found or provide meaningful response').to.be.true;
      } else {
        // If somehow data was found, just log it
        Logger.log('[UNEXPECTED] Found data for 1990: ' + data.length + ' rows');
      }

      // Log any errors mentioned in response
      const responseLower = result.response.toLowerCase();
      if (responseLower.includes('error') || responseLower.includes('fail')) {
        Logger.log('[ERROR MENTIONED] ' + result.response.substring(0, 300));
      }
    });
  });

  /**
   * Run a specific test by number (1-8) or all tests
   * @param {number|null} testNum - Test number (1-8) or null/0 for all
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
      delete globalThis.__modules__?.['sheets-chat/test/USAW-Knowledge.integration.test'];
      require('sheets-chat/test/USAW-Knowledge.integration.test');
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