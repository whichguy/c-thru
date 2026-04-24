function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ClaudeConversation.integration.test.gs - Multi-turn conversation integration test
   *
   * Validates that conversation history correctly flows across turns via messages chaining.
   * threadHistorySnippet is a per-turn delta; messages is the full accumulated history.
   * Uses Haiku (cheapest/fastest) with a compound arithmetic test to prove the model
   * actually uses prior conversation history.
   */

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var ClaudeConversation = require('chat-core/ClaudeConversation');

  var describe = mocha.describe;
  var it = mocha.it;
  var expect = chai.expect;

  describe('ClaudeConversation Multi-Turn', function() {

    it('should carry context across 3 turns with compound arithmetic', function() {
      var conv = new ClaudeConversation(null, 'claude-haiku-4-5');

      // Turn 1: establish X
      var r1 = conv.sendMessage({
        messages: [],
        text: 'Remember this number: X = 7. Reply only with "OK".',
        maxTokens: 100,
        enableThinking: false
      });
      expect(r1.success).to.equal(true);
      expect(r1.message).to.have.property('role', 'assistant');
      expect(r1.message.content).to.be.an('array');
      expect(r1.threadHistorySnippet).to.be.an('array');
      expect(r1.threadHistorySnippet.length).to.be.greaterThan(0);
      expect(r1.messages.length).to.equal(2); // user + assistant

      // Turn 2: establish Y (threadHistorySnippet == messages for turn 1, both work)
      var r2 = conv.sendMessage({
        messages: r1.messages,
        text: 'Remember this number: Y = 13. Reply only with "OK".',
        maxTokens: 100,
        enableThinking: false
      });
      expect(r2.success).to.equal(true);
      expect(r2.message).to.have.property('role', 'assistant');
      expect(r2.message.content).to.be.an('array');
      expect(r2.threadHistorySnippet).to.be.an('array');
      expect(r2.messages.length).to.be.greaterThan(r1.messages.length);
      expect(r2.messages.length).to.equal(4); // 2 prior + user + assistant

      // Turn 3: compound question (must use full messages, not snippet which is delta-only)
      var r3 = conv.sendMessage({
        messages: r2.messages,
        text: 'What is X + Y? Reply with only the number, nothing else.',
        maxTokens: 100,
        enableThinking: false
      });
      expect(r3.success).to.equal(true);
      expect(r3.message).to.have.property('role', 'assistant');
      expect(r3.message.content).to.be.an('array');
      expect(r3.messages.length).to.equal(6); // 4 prior + user + assistant

      // Extract text and verify arithmetic
      var responseText = r3.message.content
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('');
      expect(responseText).to.include('20');
    });
  });
}

__defineModule__(_main, false);