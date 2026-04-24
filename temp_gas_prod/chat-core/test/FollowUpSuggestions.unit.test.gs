function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * FollowUpSuggestions.unit.test.gs - Unit tests for follow-up action chip generation
 *
 * Tests the following functions:
 * - _extractToolSummary
 * - _readConversationContext
 * - suggestFollowUps (early-return paths only — no Haiku API call)
 */

var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var FollowUpSuggestions = require('chat-core/FollowUpSuggestions');

var describe = mocha.describe;
var it = mocha.it;
var expect = chai.expect;

// ============================================================================
// Conversation Fixture
// A realistic messages array with user, assistant (text + tool_use),
// tool_result, and final assistant text response.
// ============================================================================

var FIXTURE_MESSAGES = [
  // Turn 1: User asks about data
  {
    role: 'user',
    content: [{ type: 'text', text: 'How many rows have blank values in the Email column of the Contacts sheet?' }]
  },
  // Turn 1: Assistant uses a tool to check
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check the Contacts sheet for blank email values.' },
      {
        type: 'tool_use',
        id: 'toolu_01abc',
        name: 'exec',
        input: {
          jsCode: 'var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Contacts");',
          description: 'Count blank emails in Contacts sheet'
        }
      }
    ]
  },
  // Turn 1: Tool result
  {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_01abc',
      content: '{"success":true,"result":"23 of 150 rows have blank Email values"}'
    }]
  },
  // Turn 1: Assistant final response
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'I found 23 of 150 rows with empty Email values in the Contacts sheet. The blanks are concentrated in rows 50-80, which appear to be recently imported records.' }]
  },
  // Turn 2: User follow-up
  {
    role: 'user',
    content: [{ type: 'text', text: 'Can you highlight those empty cells?' }]
  },
  // Turn 2: Assistant response with tool
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I\'ll highlight the empty Email cells in red.' },
      {
        type: 'tool_use',
        id: 'toolu_02def',
        name: 'exec',
        input: {
          jsCode: 'var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Contacts");',
          description: 'Highlight empty Email cells with red background'
        }
      }
    ]
  },
  // Turn 2: Tool result
  {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_02def',
      content: '{"success":true,"result":"Highlighted 23 cells"}'
    }]
  },
  // Turn 2: Final assistant response
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done! I\'ve highlighted 23 empty Email cells in the Contacts sheet with a red background. The affected cells are in column E, rows 50-80.' }]
  }
];

// Minimal two-message fixture (user + assistant text only)
var FIXTURE_MINIMAL = [
  { role: 'user', content: 'What is this spreadsheet about?' },
  { role: 'assistant', content: 'This spreadsheet contains a Contacts list with 150 records including Name, Email, Phone, and Address columns.' }
];

// Greeting fixture (should produce 0 actions)
var FIXTURE_GREETING = [
  { role: 'user', content: 'Hi!' },
  { role: 'assistant', content: 'Hello! How can I help you with your spreadsheet today?' }
];


describe('FollowUpSuggestions', function() {

  // ============================================================================
  // _extractToolSummary Tests
  // ============================================================================

  describe('_extractToolSummary', function() {

    it('should return null for non-array content', function() {
      expect(FollowUpSuggestions._extractToolSummary('just a string')).to.be.null;
      expect(FollowUpSuggestions._extractToolSummary(null)).to.be.null;
      expect(FollowUpSuggestions._extractToolSummary(undefined)).to.be.null;
    });

    it('should return null for content with no tool_use blocks', function() {
      var content = [{ type: 'text', text: 'Hello world' }];
      expect(FollowUpSuggestions._extractToolSummary(content)).to.be.null;
    });

    it('should extract tool name from tool_use block', function() {
      var content = [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_01', name: 'exec', input: { jsCode: 'code' } }
      ];
      var result = FollowUpSuggestions._extractToolSummary(content);

      expect(result).to.be.an('array');
      expect(result.length).to.equal(1);
      expect(result[0].tool).to.equal('exec');
    });

    it('should extract description when present in input', function() {
      var content = [
        {
          type: 'tool_use', id: 'toolu_01', name: 'exec',
          input: { description: 'Count blank emails in Contacts sheet' }
        }
      ];
      var result = FollowUpSuggestions._extractToolSummary(content);

      expect(result[0].description).to.equal('Count blank emails in Contacts sheet');
    });

    it('should truncate description at 100 characters', function() {
      var longDesc = 'A'.repeat(150);
      var content = [
        { type: 'tool_use', id: 'toolu_01', name: 'exec', input: { description: longDesc } }
      ];
      var result = FollowUpSuggestions._extractToolSummary(content);

      expect(result[0].description.length).to.equal(100);
    });

    it('should extract multiple tool_use blocks', function() {
      var content = [
        { type: 'tool_use', id: 'toolu_01', name: 'exec', input: {} },
        { type: 'text', text: 'middle text' },
        { type: 'tool_use', id: 'toolu_02', name: 'knowledge', input: {} }
      ];
      var result = FollowUpSuggestions._extractToolSummary(content);

      expect(result.length).to.equal(2);
      expect(result[0].tool).to.equal('exec');
      expect(result[1].tool).to.equal('knowledge');
    });

    it('should omit description when not present in input', function() {
      var content = [
        { type: 'tool_use', id: 'toolu_01', name: 'exec', input: { jsCode: 'code' } }
      ];
      var result = FollowUpSuggestions._extractToolSummary(content);

      expect(result[0]).to.not.have.property('description');
    });

  });

  // ============================================================================
  // _readConversationContext Tests
  // ============================================================================

  describe('_readConversationContext', function() {

    it('should return null for null messages', function() {
      expect(FollowUpSuggestions._readConversationContext(null)).to.be.null;
    });

    it('should return null for undefined messages', function() {
      expect(FollowUpSuggestions._readConversationContext(undefined)).to.be.null;
    });

    it('should return null for empty array', function() {
      expect(FollowUpSuggestions._readConversationContext([])).to.be.null;
    });

    it('should return null for single message', function() {
      var msgs = [{ role: 'user', content: 'Hello' }];
      expect(FollowUpSuggestions._readConversationContext(msgs)).to.be.null;
    });

    it('should return null when no assistant message exists', function() {
      var msgs = [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'Anyone there?' }
      ];
      expect(FollowUpSuggestions._readConversationContext(msgs)).to.be.null;
    });

    it('should extract last user and assistant from minimal conversation', function() {
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MINIMAL);

      expect(ctx).to.not.be.null;
      expect(ctx.userMessage).to.equal('What is this spreadsheet about?');
      expect(ctx.assistantResponse).to.include('Contacts list');
    });

    it('should skip tool_result messages when finding last user', function() {
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MESSAGES);

      expect(ctx).to.not.be.null;
      // Should find "Can you highlight those empty cells?" not the tool_result
      expect(ctx.userMessage).to.equal('Can you highlight those empty cells?');
    });

    it('should extract last assistant response text', function() {
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MESSAGES);

      expect(ctx.assistantResponse).to.include('highlighted 23 empty Email cells');
    });

    it('should extract tool summary when last assistant has tool_use', function() {
      // Build a fixture where the last assistant message includes tool_use
      var msgsWithTool = [
        { role: 'user', content: [{ type: 'text', text: 'Check the data' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_01', name: 'exec', input: { description: 'Read sheet data' } }
          ]
        }
      ];
      var ctx = FollowUpSuggestions._readConversationContext(msgsWithTool);

      expect(ctx.toolSummary).to.be.an('array');
      expect(ctx.toolSummary.length).to.equal(1);
      expect(ctx.toolSummary[0].tool).to.equal('exec');
    });

    it('should return null toolSummary when last assistant is text-only', function() {
      // In FIXTURE_MESSAGES, the last assistant is a text-only response
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MESSAGES);

      expect(ctx.toolSummary).to.be.null;
    });

    it('should return null toolSummary for string content (minimal fixture)', function() {
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MINIMAL);

      expect(ctx.toolSummary).to.be.null;
    });

    it('should build digest from prior conversation history', function() {
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MESSAGES);

      // Digest should contain messages from before the last user message
      expect(ctx.digest).to.be.a('string');
      expect(ctx.digest).to.include('USER:');
      // Should include the first user message about blank values
      expect(ctx.digest).to.include('blank values');
    });

    it('should return empty digest for minimal two-message conversation', function() {
      var ctx = FollowUpSuggestions._readConversationContext(FIXTURE_MINIMAL);

      // No prior messages exist, so digest should be empty
      expect(ctx.digest).to.equal('');
    });

    it('should cap digest to 6 most recent meaningful messages', function() {
      // Build a long conversation (10 user-assistant pairs = 20 messages)
      var longConversation = [];
      for (var i = 0; i < 10; i++) {
        longConversation.push({ role: 'user', content: 'Question ' + i });
        longConversation.push({ role: 'assistant', content: 'Answer ' + i });
      }

      var ctx = FollowUpSuggestions._readConversationContext(longConversation);
      var digestLines = ctx.digest.split('\n').filter(function(l) { return l.length > 0; });

      // Should be at most 6 lines (3 user + 3 assistant from recent history)
      expect(digestLines.length).to.be.lessThan(7);
    });

    it('should truncate long messages in digest at 200 chars', function() {
      var longText = 'A'.repeat(300);
      var msgs = [
        { role: 'user', content: longText },
        { role: 'assistant', content: 'Short response to first' },
        { role: 'user', content: 'Follow up' },
        { role: 'assistant', content: 'Final' }
      ];

      var ctx = FollowUpSuggestions._readConversationContext(msgs);
      // The first user message (300 chars) should be truncated in digest
      // Format: first 100 + '...' + last 100 = 203 chars
      var lines = ctx.digest.split('\n');
      var userLine = lines.find(function(l) { return l.indexOf('USER:') === 0 && l.indexOf('AAA') !== -1; });
      if (userLine) {
        // "USER: " = 6 chars, then truncated content ~203 chars
        expect(userLine.length).to.be.lessThan(6 + 300);
        expect(userLine).to.include('...');
      }
    });

  });

  // ============================================================================
  // suggestFollowUps Tests (early-return paths — no Haiku API call)
  // ============================================================================

  describe('suggestFollowUps', function() {

    it('should return empty actions for null messages', function() {
      var result = FollowUpSuggestions.suggestFollowUps({ messages: null });
      expect(result).to.deep.equal({ actions: [] });
    });

    it('should return empty actions for empty messages array', function() {
      var result = FollowUpSuggestions.suggestFollowUps({ messages: [] });
      expect(result).to.deep.equal({ actions: [] });
    });

    it('should return empty actions for single message (no context)', function() {
      var result = FollowUpSuggestions.suggestFollowUps({
        messages: [{ role: 'user', content: 'Hello' }]
      });
      expect(result).to.deep.equal({ actions: [] });
    });

    it('should return empty actions when assistant has no text response', function() {
      // Assistant message with only tool_use, no text
      var msgs = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'exec', input: {} }
          ]
        }
      ];
      var result = FollowUpSuggestions.suggestFollowUps({ messages: msgs });
      expect(result).to.deep.equal({ actions: [] });
    });

    it('should return object with actions array shape', function() {
      // Even on error/empty, the shape should be consistent
      var result = FollowUpSuggestions.suggestFollowUps({ messages: [] });
      expect(result).to.have.property('actions');
      expect(result.actions).to.be.an('array');
    });

  });

});
}
__defineModule__(_main);
