function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * LLM-as-Judge Test for Memory Compaction
   * 
   * Tests that extractMemory() produces compacted memory that accurately
   * captures key information from conversations, validated by an LLM judge.
   */

  const { describe, it } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('Memory Compaction - LLM Judge', function() {

    it('should extract memory that aligns with conversation', function() {
      const TC = require('sheets-chat/ThreadContinuation');
      const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');

      // 1. Test conversation with clear facts
      const messages = [
        { role: 'user', content: 'Hi, I am Sarah. I work at Acme Corp on the billing system.' },
        { role: 'assistant', content: 'Hello Sarah! Nice to meet you. How can I help with the billing system?' },
        { role: 'user', content: 'I need to fix a bug in calculateTotal() in billing.js - it is not applying discounts correctly.' },
        { role: 'assistant', content: 'I can help with that. The discount bug in calculateTotal() - let me look at billing.js.' }
      ];

      // 2. Extract memory
      const memory = TC.extractMemory(messages, {});
      log('[TEST] Extracted memory: ' + JSON.stringify(memory, null, 2));

      // 3. Ask LLM to judge alignment
      const judgePrompt = `Given this conversation:
  <conversation>
  ${messages.map(m => m.role.toUpperCase() + ': ' + m.content).join('\n')}
  </conversation>

  And this compacted memory:
  <memory>
  ${JSON.stringify(memory, null, 2)}
  </memory>

  Evaluate: Does the compacted memory accurately capture the key information from the conversation?

  Key facts that MUST be captured:
  - User's name (Sarah)
  - Company (Acme Corp)
  - System being worked on (billing system)
  - Specific bug location (calculateTotal() function in billing.js)
  - Nature of bug (discounts not applied correctly)

  Return JSON only:
  {
    "aligned": true or false,
    "score": 1-10,
    "reasoning": "brief explanation",
    "missingInfo": ["any critical info from list above that is missing"],
    "extraneousInfo": ["any hallucinated info not in conversation"]
  }`;

      const judgeResult = ClaudeApiUtils.completeJSON(judgePrompt, { 
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 512 
      });

      expect(judgeResult.success).to.be.true;
      log('[TEST] Judge result: ' + JSON.stringify(judgeResult.json, null, 2));

      // 4. Assert alignment
      expect(judgeResult.json.aligned).to.be.true;
      expect(judgeResult.json.score).to.be.greaterThan(6);
      expect(judgeResult.json.missingInfo.length).to.be.lessThan(2);
    });

    it('should preserve multi-turn context in memory', function() {
      const TC = require('sheets-chat/ThreadContinuation');
      const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');

      // Conversation with evolving context
      const messages = [
        { role: 'user', content: 'I need help with my React app.' },
        { role: 'assistant', content: 'Sure, what issue are you facing?' },
        { role: 'user', content: 'The login form is not validating emails properly.' },
        { role: 'assistant', content: 'Let me help fix the email validation. What validation library are you using?' },
        { role: 'user', content: 'I am using Formik with Yup schemas.' },
        { role: 'assistant', content: 'Great, Formik with Yup is a solid choice. The email validation issue is likely in the Yup schema definition.' }
      ];

      const memory = TC.extractMemory(messages, {});
      log('[TEST] Multi-turn memory: ' + JSON.stringify(memory, null, 2));

      const judgePrompt = `Given this conversation:
  <conversation>
  ${messages.map(m => m.role.toUpperCase() + ': ' + m.content).join('\n')}
  </conversation>

  And this compacted memory:
  <memory>
  ${JSON.stringify(memory, null, 2)}
  </memory>

  Evaluate: Does the memory preserve the evolving context across multiple turns?

  Key facts to capture:
  - Technology stack (React app)
  - Feature (login form)
  - Issue (email validation)
  - Libraries (Formik, Yup)
  - Root cause hint (Yup schema definition)

  Return JSON only:
  {
    "aligned": true or false,
    "score": 1-10,
    "reasoning": "brief explanation",
    "contextPreserved": true or false,
    "missingInfo": []
  }`;

      const judgeResult = ClaudeApiUtils.completeJSON(judgePrompt, { 
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 512 
      });

      expect(judgeResult.success).to.be.true;
      log('[TEST] Judge result: ' + JSON.stringify(judgeResult.json, null, 2));

      expect(judgeResult.json.aligned).to.be.true;
      expect(judgeResult.json.contextPreserved).to.be.true;
    });

    it('should consolidate evolving state to final conclusions across episodes', function() {
      const TC = require('sheets-chat/ThreadContinuation');
      const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');

      // Simulate 3 episodes with evolving decisions on 3 topics
      // Includes specific details: URLs, file paths, port numbers, IDs that must be preserved
      const messages = [
        // === EPISODE 1: Initial decisions with specific details ===
        { role: 'user', content: 'I am building a user management system for project ID 847293651. Let us use PostgreSQL on port 5432.' },
        { role: 'assistant', content: 'PostgreSQL on port 5432 for project 847293651. I will set up the schema. The docs are at https://postgresql.org/docs/15/datatype-json.html' },
        { role: 'user', content: 'For auth, we will use JWT tokens stored in localStorage. The secret key is in /etc/secrets/jwt.key' },
        { role: 'assistant', content: 'JWT with secret from /etc/secrets/jwt.key. Token expiry will be 3600 seconds.' },
        { role: 'user', content: 'API runs on Express.js at http://localhost:3000/api/v1' },
        { role: 'assistant', content: 'Express server configured at http://localhost:3000/api/v1. Project structure created in /home/dev/user-mgmt/' },

        // === EPISODE 2: Reconsidering - some details change, some stay ===
        { role: 'user', content: 'Switching to MongoDB Atlas at mongodb+srv://cluster0.abc123.mongodb.net - better for flexible profiles.' },
        { role: 'assistant', content: 'Migrating to MongoDB Atlas. Connection string: mongodb+srv://cluster0.abc123.mongodb.net/userdb' },
        { role: 'user', content: 'Security review flagged localStorage. Moving to httpOnly cookies. New secret location: /var/run/secrets/session.key' },
        { role: 'assistant', content: 'Switching to httpOnly cookies with secret from /var/run/secrets/session.key. Much more secure.' },
        { role: 'user', content: 'Considering Fastify - benchmarks show 65000 req/sec vs Express 15000 req/sec.' },
        { role: 'assistant', content: 'Fastify performance is impressive. Evaluating migration from http://localhost:3000 to Fastify.' },

        // === EPISODE 3: Final decisions - back to some original choices with refinements ===
        { role: 'user', content: 'Final decision: PostgreSQL with JSONB on the same port 5432. Connection: postgresql://prod-db.internal:5432/users' },
        { role: 'assistant', content: 'PostgreSQL with JSONB confirmed. Production connection: postgresql://prod-db.internal:5432/users' },
        { role: 'user', content: 'Auth finalized: httpOnly cookies, refresh tokens, 7 day expiry (604800 seconds). Secret stays at /var/run/secrets/session.key' },
        { role: 'assistant', content: 'Auth complete: httpOnly + refresh tokens, 604800s expiry, secret from /var/run/secrets/session.key' },
        { role: 'user', content: 'Staying with Express at http://api.example.com:8080/v2 - team expertise matters more than raw perf.' },
        { role: 'assistant', content: 'Express confirmed at http://api.example.com:8080/v2. Deploying to production.' },
        { role: 'user', content: 'Now implement CRUD endpoints. Ticket is JIRA-4521.' },
        { role: 'assistant', content: 'Working on CRUD for JIRA-4521 using PostgreSQL JSONB and Express at the production URL.' }
      ];

      // Extract memory from full conversation
      const memory = TC.extractMemory(messages, {});
      log('[TEST] Multi-episode memory: ' + JSON.stringify(memory, null, 2));

      // LLM Judge prompt - checks final states AND specific details preservation
      const judgePrompt = `You are evaluating whether a memory extraction correctly captured FINAL conclusions from a conversation where decisions evolved multiple times.

  <conversation>
  ${messages.map(m => m.role.toUpperCase() + ': ' + m.content).join('\n')}
  </conversation>

  <extracted_memory>
  ${JSON.stringify(memory, null, 2)}
  </extracted_memory>

  <expected_final_state>
  The conversation went through 3 episodes where decisions changed. The FINAL state is:

  1. Database: PostgreSQL with JSONB (NOT MongoDB Atlas)
     - FINAL connection: postgresql://prod-db.internal:5432/users
     - OUTDATED: mongodb+srv://cluster0.abc123.mongodb.net

  2. Auth: httpOnly cookies with refresh tokens (NOT JWT in localStorage)
     - FINAL expiry: 604800 seconds (7 days)
     - FINAL secret: /var/run/secrets/session.key
     - OUTDATED: /etc/secrets/jwt.key, 3600 seconds expiry

  3. Framework: Express.js (NOT Fastify)
     - FINAL URL: http://api.example.com:8080/v2
     - OUTDATED: http://localhost:3000/api/v1

  4. Project: ID 847293651 (should be preserved throughout)
  5. Current work: JIRA-4521 ticket for CRUD endpoints
  </expected_final_state>

  EVALUATION CRITERIA:
  1. Does memory capture FINAL database (PostgreSQL+JSONB), not MongoDB?
  2. Does memory have FINAL connection string (prod-db.internal:5432), not MongoDB Atlas URL?
  3. Does memory capture FINAL auth (httpOnly cookies + refresh tokens), not JWT/localStorage?
  4. Does memory have FINAL secret path (/var/run/secrets/session.key), not old path?
  5. Does memory have FINAL expiry (604800), not old value (3600)?
  6. Does memory capture FINAL API URL (api.example.com:8080/v2), not localhost:3000?
  7. Is project ID 847293651 preserved?
  8. Does currentGoal reference JIRA-4521?
  9. Are there any OUTDATED values still present (MongoDB URL, old secret path, localhost URL)?

  Return JSON only:
  {
    "finalStatesCorrect": {
      "database": true/false,
      "databaseUrl": true/false,
      "auth": true/false,
      "secretPath": true/false,
      "expiry": true/false,
      "apiUrl": true/false,
      "projectId": true/false,
      "currentGoal": true/false
    },
    "outdatedValuesFound": ["list any OLD/intermediate values that should have been replaced"],
    "specificDetailsPreserved": {
      "projectId847293651": true/false,
      "port5432": true/false,
      "expiry604800": true/false,
      "jiraTicket": true/false
    },
    "aligned": true/false,
    "score": 1-10,
    "reasoning": "explanation of what was captured correctly/incorrectly"
  }`;

      const judgeResult = ClaudeApiUtils.completeJSON(judgePrompt, {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 1024
      });

      expect(judgeResult.success).to.be.true;
      log('[TEST] Episode evolution judge: ' + JSON.stringify(judgeResult.json, null, 2));

      // Verify all final states are captured correctly
      const judge = judgeResult.json;
      expect(judge.aligned).to.be.true;
      expect(judge.score).to.be.greaterThan(7);

      // Core decision states
      expect(judge.finalStatesCorrect.database).to.be.true;
      expect(judge.finalStatesCorrect.auth).to.be.true;
      expect(judge.finalStatesCorrect.currentGoal).to.be.true;

      // Specific details preservation
      expect(judge.specificDetailsPreserved.projectId847293651).to.be.true;
      expect(judge.specificDetailsPreserved.jiraTicket).to.be.true;

      // Strict check: NO outdated values should be present
      // The memory extraction prompt explicitly forbids historical context
      // If this fails, the extraction prompt may need adjustment
      expect(judge.outdatedValuesFound.length).to.equal(0);
    });

  });

  module.exports.__tests__ = true;
}

__defineModule__(_main);