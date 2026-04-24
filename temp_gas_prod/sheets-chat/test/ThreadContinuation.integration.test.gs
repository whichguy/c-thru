function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * Integration Test: ThreadContinuation End-to-End Proactive Flow
 * 
 * PURPOSE:
 * Tests that the complete continuation pipeline works transparently:
 * 1. Token threshold detection (proactive trigger)
 * 2. Memory extraction (rule-based fallback)
 * 3. Summary generation (fallback)
 * 4. Recent turns preservation
 * 5. Historical anchor creation
 * 6. New thread creation with proper metadata
 * 
 * NO Claude API calls - uses rule-based fallbacks for deterministic testing.
 */

const { describe, it } = require('test-framework/mocha-adapter');
const { expect } = require('test-framework/chai-assertions');

describe('ThreadContinuation Integration Tests', function() {

  describe('End-to-End Proactive Continuation', function() {
    
    it('should detect token threshold and transparently continue', function() {
      var ThreadContinuation = require('chat-core/ThreadContinuation');
      var ChatConstants = require('chat-core/ChatConstants');

      // STEP 1: Build conversation that DEFINITELY exceeds 140K token threshold
      //
      // Token calculation:
      // - Target: 140,000 tokens (threshold from ChatConstants.DEFAULTS.CONTEXT_TOKEN_THRESHOLD)
      // - estimateTokens() adds 20% margin: actual / 1.2 = raw estimate
      // - So we need: 140,000 / 1.2 * 4 chars = ~467,000 chars minimum
      // - Using 3,000 char padding × 200 messages = 600,000+ chars = ~150K+ tokens ✓
      //
      // The rule-based extractor looks for:
      // - Names: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g → stored in mentionedNames
      // - URLs: /https?:\/\/[^\s)]+/g → stored in mentionedUrls
      // - Code: /\b(function|class|const|let|var|import|export|require)\s+(\w+)/g → stored in codeTerms

      var testEntities = {
        // Use distinctive names that won't be confused with common words
        names: ['Ximenez Bartholomew', 'Petrova Alexandrova', 'Joaquin Fernandez'],
        urls: ['https://api.example.com/users/v2', 'https://docs.mycompany.io/spec', 'https://github.com/acme/widget'],
        codeTerms: ['function calculateTotalRevenue', 'class CustomerManager', 'const DATABASE_URL', 'let activeSession']
      };

      // Helper to create message content with embedded entities AND sufficient padding
      function createUserMessage(index) {
        var name = testEntities.names[index % testEntities.names.length];
        var url = testEntities.urls[index % testEntities.urls.length];
        var code = testEntities.codeTerms[index % testEntities.codeTerms.length];

        // Need ~3000 chars per message to exceed threshold
        // 'x'.repeat(2500) + entity content (~300 chars) = ~2800+ chars
        var padding = '';
        for (var i = 0; i < 2500; i++) { padding += 'x'; }  // lowercase to avoid false positive names

        return 'msg' + index + ': ' + name + ' asked about ' + url + '. need ' + code + '. ' + padding;
      }

      function createAssistantMessage(index) {
        var name = testEntities.names[(index + 1) % testEntities.names.length];
        var url = testEntities.urls[(index + 1) % testEntities.urls.length];
        var code = testEntities.codeTerms[(index + 1) % testEntities.codeTerms.length];

        var padding = '';
        for (var i = 0; i < 2500; i++) { padding += 'y'; }  // lowercase to avoid false positive names

        return 'rsp' + index + ': helped ' + name + ' with ' + url + '. used ' + code + '. ' + padding;
      }

      var messages = [];
      for (var i = 0; i < 100; i++) {
        messages.push({ role: 'user', content: createUserMessage(i) });
        messages.push({ role: 'assistant', content: createAssistantMessage(i) });
      }

      // Calculate total chars for verification
      var totalChars = messages.reduce(function(sum, m) { return sum + m.content.length; }, 0);

      log('[TEST] ========== CONVERSATION SETUP ==========');
      log('[TEST] Created ' + messages.length + ' messages');
      log('[TEST] Total characters: ' + totalChars);
      log('[TEST] Expected tokens (chars/4): ~' + Math.round(totalChars / 4));
      log('[TEST] Expected tokens with margin: ~' + Math.round(totalChars / 4 * 1.2));
      log('[TEST] Threshold to exceed: ' + ChatConstants.getConfig('CONTEXT_TOKEN_THRESHOLD'));
      log('[TEST] Test entities: ' + JSON.stringify(testEntities, null, 2));

      // STEP 2: Verify token estimation exceeds threshold
      var tokenEstimate = ThreadContinuation.estimateTokens('', messages, []);
      log('[TEST] ========== TOKEN ESTIMATION ==========');
      log('[TEST] Token estimate: ' + tokenEstimate);
      log('[TEST] Threshold: ' + ChatConstants.getConfig('CONTEXT_TOKEN_THRESHOLD'));
      log('[TEST] Over threshold: ' + (tokenEstimate > ChatConstants.getConfig('CONTEXT_TOKEN_THRESHOLD')));

      expect(tokenEstimate).to.be.greaterThan(
        ChatConstants.getConfig('CONTEXT_TOKEN_THRESHOLD'),
        'Token estimate should exceed threshold (got ' + tokenEstimate + ')'
      );

      // STEP 3: Verify shouldContinue triggers
      var shouldTrigger = ThreadContinuation.shouldContinue(tokenEstimate, messages.length);
      log('[TEST] ========== PROACTIVE DETECTION ==========');
      log('[TEST] shouldContinue result: ' + shouldTrigger);
      log('[TEST] Message count: ' + messages.length + ' (threshold: ' + ChatConstants.getConfig('MESSAGE_THRESHOLD') + ')');

      expect(shouldTrigger).to.be.true;

      // STEP 4: Handle continuation
      var conversation = {
        id: 'proactive-test-' + Date.now(),
        messages: messages,
        memory: {},
        inheritedSummary: null,
        threadSequence: 1
      };

      log('[TEST] ========== EXECUTING CONTINUATION ==========');
      log('[TEST] This will: extractMemory() → generateSummary() → getRecentTurns() → createContinuationThread()');

      var result = ThreadContinuation.handleThreadContinuation(
        conversation,
        'New user message: Ximenez Bartholomew needs help with https://api.example.com/users/v2 using function processData'
      );

      // STEP 5: DETAILED RESULT LOGGING
      log('[TEST] ========== CONTINUATION RESULT ==========');
      log('[TEST] Success: ' + result.success);
      if (!result.success) {
        log('[TEST] ERROR: ' + result.error);
        expect.fail('Continuation failed: ' + result.error);
      }
      log('[TEST] Thread continued: ' + result.threadContinued);
      log('[TEST] Elapsed: ' + result.elapsed + 'ms');
      log('[TEST] Parent thread ID: ' + result.parentThreadId);

      log('[TEST] ========== NEW THREAD STRUCTURE ==========');
      log('[TEST] New thread ID: ' + result.newThread.id);
      log('[TEST] Thread sequence: ' + result.newThread.threadSequence);
      log('[TEST] Messages preserved: ' + result.newThread.messages.length);
      log('[TEST] KEEP_RECENT_TURNS config: ' + ChatConstants.getConfig('KEEP_RECENT_TURNS'));

      // Log preserved messages summary (should be last 5 turn pairs = 10 messages max)
      log('[TEST] ========== PRESERVED MESSAGES ==========');
      result.newThread.messages.forEach(function(msg, idx) {
        var preview = (msg.content || '').substring(0, 80).replace(/[xy]/g, '').trim() + '...';
        log('[TEST] [' + idx + '] ' + msg.role + ': ' + preview);
      });

      // CRITICAL: Detailed memory quality logging
      log('[TEST] ========== MEMORY EXTRACTION QUALITY ==========');
      var memory = result.newThread.memory || {};
      var entities = memory.entities || {};

      log('[TEST] Full memory structure:');
      log('[TEST] ' + JSON.stringify(memory, null, 2));

      // Entities breakdown - NOTE: actual field names from extractMemoryRuleBased()
      log('[TEST] --- EXTRACTED ENTITIES ---');
      log('[TEST] mentionedNames: ' + JSON.stringify(entities.mentionedNames || []));
      log('[TEST] mentionedUrls: ' + JSON.stringify(entities.mentionedUrls || []));
      log('[TEST] codeTerms: ' + JSON.stringify(entities.codeTerms || []));

      // Verify expected entities were extracted
      log('[TEST] --- ENTITY VERIFICATION ---');

      // Names verification (check if our distinctive names appear in mentionedNames)
      var foundNames = entities.mentionedNames || [];
      var expectedNameParts = ['Ximenez', 'Bartholomew', 'Petrova', 'Alexandrova', 'Joaquin', 'Fernandez'];
      var nameMatches = expectedNameParts.filter(function(part) {
        return foundNames.some(function(found) {
          return found.indexOf(part) >= 0;
        });
      });
      log('[TEST] Name parts matched: ' + nameMatches.length + '/' + expectedNameParts.length);
      log('[TEST] Matched: ' + JSON.stringify(nameMatches));
      log('[TEST] All found names (may include false positives): ' + foundNames.length + ' total');

      // URL verification
      var foundUrls = entities.mentionedUrls || [];
      var urlMatches = testEntities.urls.filter(function(expected) {
        return foundUrls.some(function(found) {
          return found.indexOf(expected) >= 0 || expected.indexOf(found) >= 0;
        });
      });
      log('[TEST] URLs matched: ' + urlMatches.length + '/' + testEntities.urls.length);
      log('[TEST] Matched URLs: ' + JSON.stringify(urlMatches));
      log('[TEST] All found URLs: ' + JSON.stringify(foundUrls));

      // Code terms verification
      var foundCodeTerms = entities.codeTerms || [];
      var expectedCodeTerms = ['calculateTotalRevenue', 'CustomerManager', 'DATABASE_URL', 'activeSession'];
      var codeMatches = expectedCodeTerms.filter(function(expected) {
        return foundCodeTerms.some(function(found) {
          return found === expected;
        });
      });
      log('[TEST] Code terms matched: ' + codeMatches.length + '/' + expectedCodeTerms.length);
      log('[TEST] Matched: ' + JSON.stringify(codeMatches));
      log('[TEST] All found code terms: ' + JSON.stringify(foundCodeTerms));

      // Facts
      log('[TEST] --- FACTS ---');
      var facts = memory.facts || [];
      log('[TEST] Facts count: ' + facts.length);
      if (facts.length > 0) {
        facts.slice(0, 5).forEach(function(fact, idx) {
          log('[TEST] Fact ' + idx + ': ' + fact);
        });
        if (facts.length > 5) {
          log('[TEST] ... and ' + (facts.length - 5) + ' more facts');
        }
      }

      // Current goal
      log('[TEST] --- CURRENT GOAL ---');
      log('[TEST] Goal: ' + (memory.currentGoal || '(none - rule-based fallback does not extract goals)'));

      // CRITICAL: Summary quality logging
      log('[TEST] ========== SUMMARY QUALITY ==========');
      var summary = result.newThread.inheritedSummary || '';
      log('[TEST] Summary length: ' + summary.length + ' chars');
      log('[TEST] Summary isFallback: ' + (summary.indexOf('isFallback') >= 0 || summary.indexOf('Recent conversation:') >= 0));

      if (summary.length > 0) {
        log('[TEST] --- SUMMARY CONTENT (first 600 chars) ---');
        log('[TEST] ' + summary.substring(0, 600));
        if (summary.length > 600) {
          log('[TEST] --- SUMMARY CONTENT (last 400 chars) ---');
          log('[TEST] ...' + summary.substring(summary.length - 400));
        }
      }

      // Historical anchors
      log('[TEST] ========== HISTORICAL ANCHORS ==========');
      var anchors = result.newThread.historicalAnchors || [];
      log('[TEST] Anchor count: ' + anchors.length);
      if (anchors.length > 0) {
        anchors.forEach(function(anchor, idx) {
          log('[TEST] Anchor ' + idx + ':');
          log('[TEST]   threadId: ' + anchor.threadId);
          log('[TEST]   createdAt: ' + anchor.createdAt);
          log('[TEST]   purpose: ' + (anchor.purpose || '').substring(0, 100));
          log('[TEST]   anchors.urls: ' + JSON.stringify((anchor.anchors && anchor.anchors.urls) || []));
          log('[TEST]   anchors.files: ' + JSON.stringify((anchor.anchors && anchor.anchors.files) || []));
          log('[TEST]   anchors.errors: ' + JSON.stringify((anchor.anchors && anchor.anchors.errors) || []));
          log('[TEST]   anchors.artifacts: ' + JSON.stringify((anchor.anchors && anchor.anchors.artifacts) || []));
          log('[TEST]   anchors.decisions: ' + JSON.stringify((anchor.anchors && anchor.anchors.decisions) || []));
        });
      }

      // ASSERTIONS
      log('[TEST] ========== ASSERTIONS ==========');

      expect(result.success).to.be.true;
      log('[TEST] ✓ result.success is true');

      expect(result.newThread).to.exist;
      log('[TEST] ✓ result.newThread exists');

      expect(result.newThread.id).to.include('thread-');
      log('[TEST] ✓ newThread.id includes "thread-"');

      // lessThanOrEqual not available, use manual assertion
      if (result.newThread.messages.length > 10) {
        expect.fail('messages.length should be <= 10 but was ' + result.newThread.messages.length);
      }
      log('[TEST] ✓ messages.length <= 10 (5 turn pairs max): ' + result.newThread.messages.length);

      expect(result.newThread.inheritedSummary).to.exist;
      log('[TEST] ✓ inheritedSummary exists');

      expect(result.newThread.threadSequence).to.equal(2);
      log('[TEST] ✓ threadSequence is 2');

      expect(result.threadContinued).to.be.true;
      log('[TEST] ✓ threadContinued is true');

      // Memory quality assertions (lenient - rule-based may have false positives)
      expect(entities).to.exist;
      log('[TEST] ✓ memory.entities exists');

      expect(foundUrls.length).to.be.greaterThan(0);
      log('[TEST] ✓ At least one URL extracted: ' + foundUrls.length);

      expect(foundCodeTerms.length).to.be.greaterThan(0);
      log('[TEST] ✓ At least one code term extracted: ' + foundCodeTerms.length);

      // Anchor assertions
      expect(anchors.length).to.be.greaterThan(0);
      log('[TEST] ✓ At least one historical anchor created');

      log('[TEST] ========== ALL ASSERTIONS PASSED ==========');
    });

  });

});

module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}
__defineModule__(_main);