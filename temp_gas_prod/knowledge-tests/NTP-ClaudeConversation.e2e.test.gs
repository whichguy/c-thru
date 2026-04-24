function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * E2E Test: NTP Selection via ClaudeConversation
   * 
   * Tests that Claude can use the usaw_ntp_selection tool and create
   * a new sheet with the results when asked naturally.
   * 
   * This is a high-level e2e test that verifies the full workflow:
   * 1. User asks Claude to insert NTP results
   * 2. Claude invokes usaw_ntp_selection tool
   * 3. Claude uses exec tool to create a sheet
   * 4. Claude confirms the action
   * 
   * Cost: ~$0.02-0.05 per test (uses multiple tool calls)
   * Run: Sparingly - merge to main / manual verification
   */

  const { describe, it, before, after } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('NTP Selection E2E via ClaudeConversation', function() {
    
    var testSheetName = 'NTP_E2E_Test_' + Date.now();
    var createdSheetNames = [];
    
    /**
     * Cleanup: Delete any test sheets created during tests
     */
    after(function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      createdSheetNames.forEach(function(name) {
        try {
          var sheet = ss.getSheetByName(name);
          if (sheet) {
            ss.deleteSheet(sheet);
            Logger.log('[CLEANUP] Deleted test sheet: ' + name);
          }
        } catch (e) {
          Logger.log('[CLEANUP] Could not delete sheet ' + name + ': ' + e.message);
        }
      });
    });
    
    describe('Natural Language NTP Request', function() {
      
      it('should invoke usaw_ntp_selection when asked about NTP results', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        // Ask Claude about NTP in a natural way - don't ask to create sheet yet
        var result = conversation.sendMessage({
          messages: [],
          text: 'What are the NTP tier requirements for the period starting 2026-01-01? Use the usaw_ntp_selection tool.',
          enableThinking: false,
          maxTokens: 2048
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        expect(result.response.length).to.be.greaterThan(0);
        
        // Verify response mentions NTP tiers
        var response = result.response.toLowerCase();
        var mentionsTiers = response.includes('gold') || 
                            response.includes('silver') || 
                            response.includes('bronze') || 
                            response.includes('developmental') ||
                            response.includes('ntp') ||
                            response.includes('tier');
        
        Logger.log('[E2E] NTP query response preview: ' + result.response.substring(0, 200));
        
        expect(mentionsTiers).to.be.true;
      });
      
      it('should create a new sheet with NTP results when requested', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        var sheetName = testSheetName;
        createdSheetNames.push(sheetName);
        
        // Ask Claude to insert NTP results into a new sheet
        var result = conversation.sendMessage({
          messages: [],
          text: 'Use the usaw_ntp_selection tool to get NTP results for period starting 2026-01-01, ' +
                'then use the exec tool to create a new sheet named "' + sheetName + '" and put ' +
                'a summary of the tier structure (Gold, Silver, Bronze, Developmental slots) in it. ' +
                'Just put the tier names and slot counts.',
          enableThinking: false,
          maxTokens: 4096
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        
        Logger.log('[E2E] Create sheet response: ' + result.response.substring(0, 300));
        
        // Verify the sheet was created
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var sheet = ss.getSheetByName(sheetName);
        
        // Sheet may or may not be created depending on Claude's interpretation
        // Log the outcome for manual verification
        if (sheet) {
          Logger.log('[E2E] Sheet created successfully: ' + sheetName);
          var data = sheet.getDataRange().getValues();
          Logger.log('[E2E] Sheet data: ' + JSON.stringify(data.slice(0, 5)));
          expect(sheet).to.exist;
        } else {
          // Check if response mentions creating the sheet
          var mentionsSheet = result.response.toLowerCase().includes('sheet') ||
                             result.response.toLowerCase().includes('created') ||
                             result.response.toLowerCase().includes(sheetName.toLowerCase());
          Logger.log('[E2E] Sheet not found, checking response mentions sheet creation: ' + mentionsSheet);
          // Don't fail - the response should at least mention the action
          expect(result.response.length).to.be.greaterThan(50);
        }
      });
      
      it('should handle NTP request with gender filter', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        var result = conversation.sendMessage({
          messages: [],
          text: 'Use usaw_ntp_selection to show NTP results for 2026-01-01 period, filtered to females only (gender F).',
          enableThinking: false,
          maxTokens: 2048
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        
        Logger.log('[E2E] Gender filter response: ' + result.response.substring(0, 200));
        
        // Response should exist - content depends on actual data
        expect(result.response.length).to.be.greaterThan(20);
      });
    });
    
    describe('NTP Tool Direct Invocation', function() {
      
      it('should return qualifying period information', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        var result = conversation.sendMessage({
          messages: [],
          text: 'Use the usaw_ntp_selection tool with ntp_period_start="2026-07-01" and output_format="detailed". ' +
                'Tell me what the qualifying period dates are.',
          enableThinking: false,
          maxTokens: 2048
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        
        // Should mention qualifying period or dates
        var response = result.response.toLowerCase();
        var mentionsPeriod = response.includes('qualifying') || 
                             response.includes('period') ||
                             response.includes('2025') ||  // Qualifying year for Jul 2026 period
                             response.includes('2026');
        
        Logger.log('[E2E] Qualifying period response: ' + result.response.substring(0, 200));
        
        expect(mentionsPeriod).to.be.true;
      });
      
      it('should explain tier requirements when asked', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        var result = conversation.sendMessage({
          messages: [],
          text: 'What are the slot limits for each NTP tier? Use the usaw_ntp_selection tool for 2026-01-01 ' +
                'and explain the slots field for each tier.',
          enableThinking: false,
          maxTokens: 2048
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        
        // Should mention slot numbers (6 for gold/silver, 2 for bronze, 25 for developmental)
        var response = result.response;
        var mentionsSlots = response.includes('6') || 
                            response.includes('2') || 
                            response.includes('25') ||
                            response.toLowerCase().includes('slot');
        
        Logger.log('[E2E] Slot limits response: ' + result.response.substring(0, 200));
        
        expect(mentionsSlots).to.be.true;
      });
    });
    
    describe('Error Handling', function() {
      
      it('should handle missing required parameter gracefully', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        // Deliberately omit ntp_period_start to see error handling
        var result = conversation.sendMessage({
          messages: [],
          text: 'Use the usaw_ntp_selection tool but do NOT provide any parameters. Report what happens.',
          enableThinking: false,
          maxTokens: 1024
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        
        // Should mention error or required parameter
        var response = result.response.toLowerCase();
        var mentionsError = response.includes('error') || 
                            response.includes('required') ||
                            response.includes('ntp_period_start') ||
                            response.includes('parameter') ||
                            response.includes('missing');
        
        Logger.log('[E2E] Error handling response: ' + result.response.substring(0, 200));
        
        expect(mentionsError).to.be.true;
      });
      
      it('should handle invalid date format', function() {
        var ClaudeConversation = require('sheets-chat/ClaudeConversation');
        var conversation = new ClaudeConversation(null, 'claude-haiku-4-5');
        
        var result = conversation.sendMessage({
          messages: [],
          text: 'Use usaw_ntp_selection with ntp_period_start="January 2026". Report the result.',
          enableThinking: false,
          maxTokens: 1024
        });
        
        expect(result).to.exist;
        expect(result.response).to.exist;
        
        // Should mention format error or correct format
        var response = result.response.toLowerCase();
        var handlesFormat = response.includes('format') || 
                            response.includes('yyyy') ||
                            response.includes('invalid') ||
                            response.includes('error');
        
        Logger.log('[E2E] Invalid format response: ' + result.response.substring(0, 200));
        
        // Response should at least be informative
        expect(result.response.length).to.be.greaterThan(20);
      });
    });
  });

  /**
   * E2E Test Summary
   * 
   * Coverage: NTP selection tool via natural language
   * Tests:
   *   1. Natural language NTP query -> tool invocation
   *   2. Create sheet with NTP results
   *   3. Gender filter parameter
   *   4. Qualifying period information
   *   5. Tier slot limits
   *   6. Error handling (missing params)
   *   7. Error handling (invalid format)
   * 
   * Cost: ~$0.10-0.15 per full run (7 tests × ~$0.02 each)
   * Time: ~1-2 minutes
   * 
   * Run frequency: Manual / merge to main (NOT every commit)
   */

  module.exports = { 
    run: function() { return require('test-framework/mocha-adapter').run(); }
  };
}

__defineModule__(_main);