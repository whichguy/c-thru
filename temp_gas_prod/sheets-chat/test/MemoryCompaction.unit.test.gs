function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Unit Tests: Generational Memory Compaction
   * 
   * Tests the memory truncation and generational demotion system:
   * - estimateMemoryTokens() correctly estimates memory size
   * - truncateMemory() reduces memory to fit budget
   * - demoteGenerations() shifts Gen 0 → Gen 1 → Gen 2
   * - compressToEpisode() compresses current to episode summary
   * - mergeIntoArchive() merges episodes into archive gist
   * - enforceMemoryBudget() keeps memory within total budget
   */

  const { describe, it } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('Memory Compaction Unit Tests', function() {

    describe('estimateMemoryTokens', function() {

      it('should return 0 for null/undefined memory', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        expect(TC.estimateMemoryTokens(null)).to.equal(0);
        expect(TC.estimateMemoryTokens(undefined)).to.equal(0);
      });

      it('should estimate tokens for flat memory structure', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const memory = {
          entities: { project: { name: 'TestProject', id: '123' } },
          facts: ['Fact 1', 'Fact 2', 'Fact 3'],
          currentGoal: 'Build feature X'
        };
        
        const tokens = TC.estimateMemoryTokens(memory);
        log('[TEST] Flat memory tokens: ' + tokens);
        
        // Should be > 0 and reasonable
        expect(tokens).to.be.greaterThan(0);
        expect(tokens).to.be.lessThan(500); // Small object should be < 500 tokens
      });

      it('should estimate tokens for generational memory structure', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const memory = {
          current: {
            entities: { project: { name: 'Current' } },
            facts: ['Current fact 1', 'Current fact 2'],
            currentGoal: 'Working on X'
          },
          recent: {
            episodes: [
              { summary: 'Episode 1', keyDecisions: ['Decision 1'], keyEntities: ['Entity 1'] },
              { summary: 'Episode 2', keyDecisions: ['Decision 2'], keyEntities: ['Entity 2'] }
            ]
          },
          archive: {
            gist: 'Historical work summary.',
            importantFacts: ['Old fact 1', 'Old fact 2']
          }
        };
        
        const tokens = TC.estimateMemoryTokens(memory);
        log('[TEST] Generational memory tokens: ' + tokens);
        
        expect(tokens).to.be.greaterThan(0);
        expect(tokens).to.be.lessThan(1000);
      });

    });

    describe('truncateMemory', function() {

      it('should return memory unchanged if under budget', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const memory = {
          entities: { project: 'Test' },
          facts: ['Fact 1'],
          currentGoal: 'Goal'
        };
        
        const truncated = TC.truncateMemory(memory, 10000);
        
        expect(truncated.facts.length).to.equal(1);
        expect(truncated.currentGoal).to.equal('Goal');
      });

      it('should truncate large flat memory to fit budget', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        // Create artificially large memory
        const largeMemory = {
          entities: {},
          facts: [],
          currentGoal: 'Test goal'
        };
        
        // Add 100 facts (each ~100 chars = ~33 tokens)
        for (var i = 0; i < 100; i++) {
          largeMemory.facts.push('This is fact number ' + i + ' with some additional context about the project and decisions made during development iteration ' + i);
        }
        
        // Add large entities
        for (var j = 0; j < 20; j++) {
          largeMemory.entities['project_' + j] = {
            name: 'Project ' + j,
            description: 'A detailed description of project ' + j + ' with lots of context',
            settings: { key1: 'value1', key2: 'value2', key3: 'value3' }
          };
        }
        
        const originalTokens = TC.estimateMemoryTokens(largeMemory);
        log('[TEST] Original flat memory: ' + originalTokens + ' tokens');
        
        // Truncate to 500 tokens (very aggressive)
        const truncated = TC.truncateMemory(largeMemory, 500);
        const truncatedTokens = TC.estimateMemoryTokens(truncated);
        log('[TEST] Truncated flat memory: ' + truncatedTokens + ' tokens');
        
        expect(truncatedTokens).to.be.lessThan(600); // Allow some overhead
        expect(truncated.currentGoal).to.equal('Test goal'); // Goal preserved
        expect(truncated.facts.length).to.be.greaterThan(0); // Some facts kept
        expect(truncated.facts.length).to.be.lessThan(100); // But reduced
      });

      it('should truncate large generational memory progressively', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        // Create large generational memory
        const largeMemory = {
          current: {
            entities: {},
            facts: [],
            currentGoal: 'Current goal'
          },
          recent: {
            episodes: []
          },
          archive: {
            gist: '',
            importantFacts: []
          }
        };
        
        // Add lots of current facts
        for (var i = 0; i < 50; i++) {
          largeMemory.current.facts.push('Current fact ' + i + ' with detailed context about ongoing work');
        }
        
        // Add large entities
        for (var j = 0; j < 15; j++) {
          largeMemory.current.entities['entity_' + j] = {
            name: 'Entity ' + j,
            data: 'Some data for entity ' + j
          };
        }
        
        // Add many recent episodes
        for (var k = 0; k < 10; k++) {
          largeMemory.recent.episodes.push({
            summary: 'Episode ' + k + ' summary with details',
            keyDecisions: ['Decision ' + k + 'a', 'Decision ' + k + 'b'],
            keyEntities: ['Entity ' + k]
          });
        }
        
        // Add large archive
        var gistParts = [];
        for (var m = 0; m < 20; m++) {
          gistParts.push('Historical context ' + m + '.');
        }
        largeMemory.archive.gist = gistParts.join(' ');
        
        for (var n = 0; n < 10; n++) {
          largeMemory.archive.importantFacts.push('Important fact ' + n);
        }
        
        const originalTokens = TC.estimateMemoryTokens(largeMemory);
        log('[TEST] Original generational memory: ' + originalTokens + ' tokens');
        
        // Truncate to 1000 tokens
        const truncated = TC.truncateMemory(largeMemory, 1000);
        const truncatedTokens = TC.estimateMemoryTokens(truncated);
        log('[TEST] Truncated generational memory: ' + truncatedTokens + ' tokens');
        
        log('[TEST] Archive gist length: ' + truncated.archive.gist.length);
        log('[TEST] Archive facts: ' + truncated.archive.importantFacts.length);
        log('[TEST] Recent episodes: ' + truncated.recent.episodes.length);
        log('[TEST] Current facts: ' + truncated.current.facts.length);
        log('[TEST] Current entities: ' + Object.keys(truncated.current.entities).length);
        
        expect(truncatedTokens).to.be.lessThan(1100); // Allow some overhead
        expect(truncated.current.currentGoal).to.equal('Current goal'); // Goal preserved
      });

    });

    describe('demoteGenerations', function() {

      it('should convert flat memory to recent episode', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const flatMemory = {
          entities: { project: { name: 'Test', id: '123' } },
          facts: ['Fact 1', 'Fact 2'],
          currentGoal: 'Build feature'
        };
        
        const demoted = TC.demoteGenerations(flatMemory);
        
        log('[TEST] Demoted from flat: ' + JSON.stringify(demoted, null, 2));
        
        // Current should be empty
        expect(demoted.current.facts.length).to.equal(0);
        expect(Object.keys(demoted.current.entities).length).to.equal(0);
        
        // Should have 1 recent episode
        expect(demoted.recent.episodes.length).to.equal(1);
        expect(demoted.recent.episodes[0].summary).to.equal('Build feature');
      });

      it('should demote current to recent and oldest recent to archive', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const generationalMemory = {
          current: {
            entities: { project: { name: 'Current' } },
            facts: ['Current fact'],
            currentGoal: 'Current goal'
          },
          recent: {
            episodes: [
              { summary: 'Episode 1', keyDecisions: [], keyEntities: ['e1'] },
              { summary: 'Episode 2', keyDecisions: [], keyEntities: ['e2'] },
              { summary: 'Episode 3', keyDecisions: [], keyEntities: ['e3'] }
            ]
          },
          archive: {
            gist: 'Old history.',
            importantFacts: ['old1']
          }
        };
        
        const demoted = TC.demoteGenerations(generationalMemory);
        
        log('[TEST] Demoted generational: ' + JSON.stringify(demoted, null, 2));
        
        // Current should be empty
        expect(demoted.current.facts.length).to.equal(0);
        
        // Should still have max 3 recent episodes (config default)
        // Original current becomes recent[0], oldest episode goes to archive
        expect(demoted.recent.episodes.length).to.be.lessThan(5);
        
        // Archive should have grown
        expect(demoted.archive.gist.length).to.be.greaterThan(0);
      });

      it('should handle null/undefined memory', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const demotedNull = TC.demoteGenerations(null);
        const demotedUndefined = TC.demoteGenerations(undefined);
        
        expect(demotedNull.current).to.exist;
        expect(demotedNull.recent.episodes.length).to.equal(0);
        expect(demotedNull.archive.gist).to.equal('');
        
        expect(demotedUndefined.current).to.exist;
      });

    });

    describe('compressToEpisode', function() {

      it('should compress current generation to episode summary', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const current = {
          entities: {
            projects: { main: { id: 'proj-123' } },
            decisions: ['Use PostgreSQL', 'Use Express.js']
          },
          facts: ['Built auth system', 'Added user model'],
          currentGoal: 'Implement user authentication'
        };
        
        const episode = TC.compressToEpisode(current);
        
        log('[TEST] Compressed episode: ' + JSON.stringify(episode, null, 2));
        
        expect(episode.summary).to.equal('Implement user authentication');
        expect(episode.keyDecisions.length).to.be.greaterThan(0);
        expect(episode.keyEntities.length).to.be.greaterThan(0);
      });

      it('should handle empty/null current', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const episodeNull = TC.compressToEpisode(null);
        const episodeEmpty = TC.compressToEpisode({});
        
        expect(episodeNull.summary).to.equal('');
        expect(episodeEmpty.summary).to.equal('Worked on tasks'); // Default
      });

    });

    describe('mergeIntoArchive', function() {

      it('should merge episode into archive gist', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const archive = {
          gist: 'Previously worked on project setup.',
          importantFacts: ['fact1']
        };
        
        const episode = {
          summary: 'Built authentication system',
          keyDecisions: ['JWT tokens'],
          keyEntities: ['userModel: User']
        };
        
        const merged = TC.mergeIntoArchive(archive, episode);
        
        log('[TEST] Merged archive: ' + JSON.stringify(merged, null, 2));
        
        expect(merged.gist).to.include('Built authentication system');
        expect(merged.gist).to.include('Previously worked on');
        expect(merged.importantFacts.length).to.be.greaterThan(1);
      });

      it('should trim gist to max length', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        const ChatConstants = require('sheets-chat/ChatConstants');
        
        // Create archive with gist near max length
        var longGist = '';
        for (var i = 0; i < 100; i++) {
          longGist += 'Word' + i + ' ';
        }
        
        const archive = {
          gist: longGist,
          importantFacts: []
        };
        
        const episode = {
          summary: 'New work added to gist',
          keyDecisions: [],
          keyEntities: []
        };
        
        const merged = TC.mergeIntoArchive(archive, episode);
        
        const maxLength = ChatConstants.getConfig('MEMORY_GEN2_MAX_GIST_LENGTH');
        log('[TEST] Merged gist length: ' + merged.gist.length + ' (max: ' + maxLength + ')');
        
        // Should be trimmed to max length or less
        expect(merged.gist.length).to.be.lessThan(maxLength + 50); // Small buffer for sentence boundary
      });

    });

    describe('enforceMemoryBudget', function() {

      it('should return memory unchanged if under budget', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const smallMemory = {
          current: { entities: {}, facts: ['fact'], currentGoal: 'goal' },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        
        const result = TC.enforceMemoryBudget(smallMemory);
        
        expect(result.current.facts.length).to.equal(1);
        expect(result.current.currentGoal).to.equal('goal');
      });

      it('should compact memory to fit within total budget', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        const ChatConstants = require('sheets-chat/ChatConstants');
        
        // Create memory that exceeds budget
        const largeMemory = {
          current: {
            entities: {},
            facts: [],
            currentGoal: 'goal'
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        
        // Add enough content to exceed 4000 token budget
        for (var i = 0; i < 200; i++) {
          largeMemory.current.facts.push('This is fact number ' + i + ' with substantial content to inflate token count beyond budget limit');
        }
        
        const originalTokens = TC.estimateMemoryTokens(largeMemory);
        log('[TEST] Original tokens: ' + originalTokens);
        
        const result = TC.enforceMemoryBudget(largeMemory);
        const resultTokens = TC.estimateMemoryTokens(result);
        
        log('[TEST] Result tokens: ' + resultTokens);
        log('[TEST] Budget: ' + ChatConstants.getConfig('MEMORY_TOTAL_BUDGET_TOKENS'));
        
        expect(resultTokens).to.be.lessThan(ChatConstants.getConfig('MEMORY_TOTAL_BUDGET_TOKENS') + 500);
      });

    });

    describe('Tool Result Extraction', function() {

      it('should detect project identifiers in content', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const contentWithIds = '{"scriptId": "1Y72rigcMUAwRd7bwl3CR57O6ENo5sKTn0xAl2C4HoZys75N5utGfkCUG"}';
        const contentWithoutIds = 'Just some regular text without any identifiers';
        
        expect(TC.containsProjectIdentifiers(contentWithIds)).to.equal(true);
        expect(TC.containsProjectIdentifiers(contentWithoutIds)).to.equal(false);
      });

      it('should extract scriptId from tool result content', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const content = '{"scriptId": "1Y72rigcMUAwRd7bwl3CR57O6ENo5sKTn0xAl2C4HoZys75N5utGfkCUG", "title": "Test Project"}';
        
        const identifiers = TC.extractIdentifiers(content);
        
        log('[TEST] Extracted identifiers: ' + JSON.stringify(identifiers));
        
        expect(identifiers.scriptId).to.equal('1Y72rigcMUAwRd7bwl3CR57O6ENo5sKTn0xAl2C4HoZys75N5utGfkCUG');
      });

      it('should extract URLs from tool result content', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const content = '{"webAppUrl": "https://script.google.com/macros/s/AKfycby123456/exec"}';
        
        const identifiers = TC.extractIdentifiers(content);
        
        log('[TEST] Extracted URLs: ' + JSON.stringify(identifiers.urls));
        
        expect(identifiers.urls).to.exist;
        expect(identifiers.urls.length).to.be.greaterThan(0);
        expect(identifiers.urls[0]).to.include('script.google.com');
      });

      it('should extract tool results from messages', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const messages = [
          { role: 'user', content: 'Create a new project' },
          { 
            role: 'assistant', 
            content: [{
              type: 'tool_result',
              name: 'mcp__gas__project_create',
              content: '{"scriptId": "1abc2def3ghi4jkl5mno6pqr7stu8vwx9yz0123456789"}'
            }]
          }
        ];
        
        const toolResults = TC.extractToolResultsFromMessages(messages);
        
        log('[TEST] Extracted tool results: ' + JSON.stringify(toolResults));
        
        expect(toolResults.length).to.be.greaterThan(0);
        expect(toolResults[0].type).to.equal('identifiers');
        expect(toolResults[0].content.scriptId).to.equal('1abc2def3ghi4jkl5mno6pqr7stu8vwx9yz0123456789');
      });

      it('should detect config-like content', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        expect(TC.looksLikeConfig('{"key": "value"}')).to.equal(true);
        expect(TC.looksLikeConfig({ key: 'value' })).to.equal(true);
        expect(TC.looksLikeConfig('API_KEY=abc123')).to.equal(true);
        expect(TC.looksLikeConfig('Just regular text')).to.equal(false);
      });

      it('should detect API data in content', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const apiResponse = '{"success": true, "id": "12345", "result": {}}';
        const regularContent = 'This is just a message';
        
        expect(TC.containsApiData(apiResponse)).to.equal(true);
        expect(TC.containsApiData(regularContent)).to.equal(false);
      });

    });

    describe('Contradiction Detection', function() {

      it('should detect stale language in facts', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const memory = {
          current: {
            entities: {},
            facts: [
              'Using PostgreSQL for database',  // OK
              'Previously used MongoDB, now using PostgreSQL',  // STALE
              'Switched from REST to GraphQL'  // STALE
            ],
            currentGoal: 'Test goal'
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        
        const validation = TC.validateMemoryContradictions(memory, {});
        
        log('[TEST] Validation issues: ' + JSON.stringify(validation.issues));
        
        // Should find stale language
        const staleIssues = validation.issues.filter(function(i) { return i.type === 'STALE_LANGUAGE'; });
        expect(staleIssues.length).to.be.greaterThan(0);
      });

      it('should detect superseded references', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const newMemory = {
          current: {
            entities: { decisions: { database: 'PostgreSQL' } },
            facts: ['MongoDB connection string is stored in config'],  // References old DB
            currentGoal: 'Test'
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        const existingMemory = {
          current: {
            entities: { decisions: { database: 'MongoDB' } },
            facts: [],
            currentGoal: null
          }
        };
        
        const validation = TC.validateMemoryContradictions(newMemory, existingMemory);
        
        log('[TEST] Superseded issues: ' + JSON.stringify(validation.issues));
        
        // Should detect MongoDB reference as superseded
        var hasSuperseded = validation.issues.some(function(i) { return i.type === 'SUPERSEDED_REFERENCE'; });
        expect(hasSuperseded).to.equal(true);
      });

      it('should detect anchor loss', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const newMemory = {
          current: {
            entities: { anchors: {} },  // Lost scriptId!
            facts: [],
            currentGoal: null
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        const existingMemory = {
          current: {
            entities: { anchors: { scriptId: '1abc2def...' } },
            facts: [],
            currentGoal: null
          }
        };
        
        const validation = TC.validateMemoryContradictions(newMemory, existingMemory);
        
        log('[TEST] Anchor loss issues: ' + JSON.stringify(validation.issues));
        
        expect(validation.hasCritical).to.equal(true);
        var hasAnchorLoss = validation.issues.some(function(i) { return i.type === 'ANCHOR_LOSS'; });
        expect(hasAnchorLoss).to.equal(true);
      });

      it('should auto-restore lost anchors', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const newMemory = {
          current: {
            entities: { anchors: {} },
            facts: [],
            currentGoal: null
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        const existingMemory = {
          current: {
            entities: { anchors: { scriptId: '1abc2def3ghi4jkl' } },
            facts: [],
            currentGoal: null
          }
        };
        
        const validation = TC.validateMemoryContradictions(newMemory, existingMemory);
        const repaired = TC.repairMemoryContradictions(validation, existingMemory);
        
        log('[TEST] Repaired anchors: ' + JSON.stringify(repaired.current.entities.anchors));
        
        expect(repaired.current.entities.anchors.scriptId).to.equal('1abc2def3ghi4jkl');
      });

      it('should detect duplicate facts', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const memory = {
          current: {
            entities: {},
            facts: [
              'Using PostgreSQL',
              'User prefers tabs',
              'Using PostgreSQL',  // Duplicate
              'Project deadline is Q1'
            ],
            currentGoal: 'Test'
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        
        const validation = TC.validateMemoryContradictions(memory, {});
        
        var hasDuplicate = validation.issues.some(function(i) { return i.type === 'DUPLICATE_FACT'; });
        expect(hasDuplicate).to.equal(true);
      });

    });

    describe('Fact Deduplication', function() {

      it('should remove exact duplicate facts', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const facts = [
          'Using PostgreSQL',
          'User prefers tabs',
          'Using PostgreSQL',
          'Project uses Express.js'
        ];
        
        const deduplicated = TC.deduplicateFacts(facts);
        
        log('[TEST] Deduplicated: ' + JSON.stringify(deduplicated));
        
        expect(deduplicated.length).to.equal(3);
        expect(deduplicated).to.include('Using PostgreSQL');
        expect(deduplicated).to.include('User prefers tabs');
        expect(deduplicated).to.include('Project uses Express.js');
      });

      it('should remove near-duplicate facts (substring match)', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        const facts = [
          'Using PostgreSQL for the database layer',
          'Using PostgreSQL for the database layer with connection pooling'  // Contains first fact
        ];
        
        const deduplicated = TC.deduplicateFacts(facts);
        
        log('[TEST] Near-duplicate removal: ' + JSON.stringify(deduplicated));
        
        // Should keep first occurrence
        expect(deduplicated.length).to.equal(1);
      });

      it('should handle empty and invalid input', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        expect(TC.deduplicateFacts([])).to.deep.equal([]);
        expect(TC.deduplicateFacts(null)).to.deep.equal([]);
        expect(TC.deduplicateFacts(undefined)).to.deep.equal([]);
      });

    });

    describe('Integration: Full extraction with truncation', function() {

      it('should handle continuation with large existing memory', function() {
        const TC = require('sheets-chat/ThreadContinuation');
        
        // Simulate large existing memory that would overflow without truncation
        const largeExistingMemory = {
          current: {
            entities: {},
            facts: [],
            currentGoal: 'Previous goal'
          },
          recent: { episodes: [] },
          archive: { gist: '', importantFacts: [] }
        };
        
        // Add substantial content
        for (var i = 0; i < 30; i++) {
          largeExistingMemory.current.facts.push('Previous fact ' + i + ' from earlier conversation with detailed context');
        }
        
        for (var j = 0; j < 5; j++) {
          largeExistingMemory.recent.episodes.push({
            summary: 'Episode ' + j,
            keyDecisions: ['Decision ' + j],
            keyEntities: ['Entity ' + j]
          });
        }
        
        // Test demoteGenerations handles it
        const demoted = TC.demoteGenerations(largeExistingMemory);
        
        log('[TEST] Demoted result episodes: ' + demoted.recent.episodes.length);
        log('[TEST] Demoted archive gist length: ' + demoted.archive.gist.length);
        
        expect(demoted).to.have.property('current');
        expect(demoted).to.have.property('recent');
        expect(demoted).to.have.property('archive');
        expect(demoted.current.facts.length).to.equal(0); // Current cleared after demotion
      });

    });

  });

  module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}

__defineModule__(_main);