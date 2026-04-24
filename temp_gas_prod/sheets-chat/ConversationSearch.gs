function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  // Dependencies
  const UISupport = require('sheets-chat/UISupport');

  /**
   * Search configuration
   * @type {Object}
   */
  const SEARCH_CONFIG = {
    maxResults: 10,
    excerptContextChars: 200,
    minQueryLength: 2,
    maxConversationsToSearch: 100
  };

  /**
   * Search across all archived conversations for matching content
   *
   * @param {string} query - Search query (keywords or phrase)
   * @param {Object} options - Search options
   * @param {string} options.searchType - 'keyword' | 'date_range'
   * @param {number} options.maxResults - Maximum results to return
   * @returns {Object} {success, data: {results, totalMatches, searchedConversations}}
   */
  function searchConversationHistory(query, options = {}) {
    const startTime = Date.now();
    const {
      searchType = 'keyword',
      maxResults = SEARCH_CONFIG.maxResults
    } = options;

    try {
      // Validate query
      if (!query || typeof query !== 'string') {
        return {
          success: false,
          error: 'Invalid query: must be a non-empty string'
        };
      }

      const trimmedQuery = query.trim().toLowerCase();
      if (trimmedQuery.length < SEARCH_CONFIG.minQueryLength) {
        return {
          success: false,
          error: `Query too short: minimum ${SEARCH_CONFIG.minQueryLength} characters`
        };
      }

      // Get current user for isolation
      const currentUser = UISupport.getCurrentUserEmail();

      // Get all conversations for this user
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName('Conversations');

      if (!sheet) {
        return {
          success: true,
          data: {
            results: [],
            totalMatches: 0,
            searchedConversations: 0
          }
        };
      }

      const lastRow = sheet.getLastRow();
      if (lastRow < 2) {
        return {
          success: true,
          data: {
            results: [],
            totalMatches: 0,
            searchedConversations: 0
          }
        };
      }

      // Get all data (skip header row)
      const data = sheet.getRange(`A2:F${Math.min(lastRow, SEARCH_CONFIG.maxConversationsToSearch + 1)}`).getValues();

      const results = [];
      let searchedConversations = 0;

      for (let i = 0; i < data.length; i++) {
        const rowId = data[i][0];        // Column A: ID
        const rowTitle = data[i][1];     // Column B: Title
        const rowUser = data[i][2];      // Column C: User
        const jsonData = data[i][3];     // Column D: Data
        const savedAt = data[i][4];      // Column E: Saved At
        const preview = data[i][5];      // Column F: Preview

        // Skip if not current user's conversation
        if (rowUser !== currentUser) continue;
        if (!rowId || !jsonData) continue;

        searchedConversations++;

        // Parse conversation data
        let parsed;
        try {
          parsed = JSON.parse(jsonData);
        } catch (e) {
          continue; // Skip corrupted data
        }

        // Build searchable text
        const searchText = buildSearchableText(parsed, rowTitle, preview);
        const lowerSearchText = searchText.toLowerCase();

        // Check for match
        if (lowerSearchText.includes(trimmedQuery)) {
          // Extract relevant excerpt
          const excerpt = extractRelevantExcerpt(parsed.messages, query);

          // Calculate relevance score (basic TF-based)
          const relevance = calculateRelevance(lowerSearchText, trimmedQuery);

          results.push({
            conversationId: rowId,
            title: rowTitle,
            savedAt: savedAt,
            excerpt: excerpt,
            relevance: relevance,
            threadSequence: parsed.threadSequence || 1,
            parentThread: parsed.parentThread || null,
            hasMemory: !!parsed.memory
          });
        }
      }

      // Sort by relevance (descending)
      results.sort((a, b) => b.relevance - a.relevance);

      // Limit results
      const limitedResults = results.slice(0, maxResults);

      const elapsed = Date.now() - startTime;
      log(`[ConversationSearch] Found ${results.length} matches in ${searchedConversations} conversations (${elapsed}ms)`);

      return {
        success: true,
        data: {
          results: limitedResults,
          totalMatches: results.length,
          searchedConversations: searchedConversations,
          searchTimeMs: elapsed
        }
      };

    } catch (error) {
      log(`[ConversationSearch] Search error: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Build searchable text from conversation data
   *
   * @param {Object} parsed - Parsed conversation data
   * @param {string} title - Conversation title
   * @param {string} preview - Conversation preview
   * @returns {string} Concatenated searchable text
   */
  function buildSearchableText(parsed, title, preview) {
    const parts = [title || '', preview || ''];

    // Add message content
    if (parsed.messages && Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        const text = extractTextFromMessage(msg);
        if (text) {
          parts.push(text);
        }
      }
    }

    // Add memory facts if present
    if (parsed.memory && parsed.memory.facts) {
      parts.push(parsed.memory.facts.join(' '));
    }

    // Add inherited summary if present
    if (parsed.inheritedSummary) {
      parts.push(parsed.inheritedSummary);
    }

    return parts.join(' ');
  }

  /**
   * Extract text content from a message object
   *
   * @param {Object} msg - Message object
   * @returns {string} Extracted text
   */
  function extractTextFromMessage(msg) {
    if (!msg || !msg.content) return '';

    if (typeof msg.content === 'string') {
      return msg.content;
    }

    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(block => block.type === 'text' && block.text)
        .map(block => block.text)
        .join(' ');
    }

    return '';
  }

  /**
   * Extract relevant excerpt around query match
   *
   * @param {Array} messages - Message array
   * @param {string} query - Search query
   * @returns {string|null} Excerpt with context or null
   */
  function extractRelevantExcerpt(messages, query) {
    if (!messages || !Array.isArray(messages)) return null;

    const lowerQuery = query.toLowerCase();
    const contextChars = SEARCH_CONFIG.excerptContextChars;

    for (const msg of messages) {
      const text = extractTextFromMessage(msg);
      if (!text) continue;

      const idx = text.toLowerCase().indexOf(lowerQuery);
      if (idx !== -1) {
        const start = Math.max(0, idx - contextChars);
        const end = Math.min(text.length, idx + query.length + contextChars);

        let excerpt = text.substring(start, end);

        // Add ellipses if truncated
        if (start > 0) excerpt = '...' + excerpt;
        if (end < text.length) excerpt = excerpt + '...';

        return excerpt;
      }
    }

    return null;
  }

  /**
   * Calculate relevance score for a match
   * Basic term frequency based scoring
   *
   * @param {string} text - Full text to search
   * @param {string} query - Search query
   * @returns {number} Relevance score (0-1)
   */
  function calculateRelevance(text, query) {
    // Count occurrences
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = text.match(regex) || [];
    const count = matches.length;

    // Normalize by text length (TF-like)
    const tf = count / Math.max(1, text.length / 1000);

    // Cap at 1.0
    return Math.min(1, tf);
  }

  /**
   * Search within a specific thread chain
   * Follows parent/child links to search entire chain
   *
   * @param {string} threadId - Starting thread ID
   * @param {string} query - Search query
   * @returns {Object} {success, data: {results, chainLength}}
   */
  function searchThreadChain(threadId, query) {
    try {
      const results = [];
      const visited = new Set();
      const toVisit = [threadId];

      while (toVisit.length > 0) {
        const currentId = toVisit.shift();
        if (visited.has(currentId)) continue;
        visited.add(currentId);

        // Load conversation
        const loadResult = UISupport.loadConversation(currentId);
        if (!loadResult.success) continue;

        const data = loadResult.data;

        // Search this thread
        const text = buildSearchableText({
          messages: data.messages,
          memory: data.memory,
          inheritedSummary: data.inheritedSummary
        }, '', '');

        if (text.toLowerCase().includes(query.toLowerCase())) {
          const excerpt = extractRelevantExcerpt(data.messages, query);
          results.push({
            conversationId: currentId,
            excerpt: excerpt,
            threadSequence: data.threadSequence || 1
          });
        }

        // Add parent and child to visit queue
        if (data.parentThread && !visited.has(data.parentThread)) {
          toVisit.push(data.parentThread);
        }
        if (data.childThread && !visited.has(data.childThread)) {
          toVisit.push(data.childThread);
        }
      }

      // Sort by thread sequence
      results.sort((a, b) => a.threadSequence - b.threadSequence);

      return {
        success: true,
        data: {
          results: results,
          chainLength: visited.size
        }
      };

    } catch (error) {
      log(`[ConversationSearch] Thread chain search error: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get the full thread chain for a conversation
   * Returns all linked conversations in order
   *
   * @param {string} threadId - Any thread ID in the chain
   * @returns {Object} {success, data: {chain: [{id, title, threadSequence}]}}
   */
  function getThreadChain(threadId) {
    try {
      const chain = [];
      const visited = new Set();

      // First, walk up to find the root
      let currentId = threadId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);

        const loadResult = UISupport.loadConversation(currentId);
        if (!loadResult.success) break;

        const data = loadResult.data;
        if (data.parentThread && !visited.has(data.parentThread)) {
          currentId = data.parentThread;
        } else {
          // Found root
          break;
        }
      }

      // Now walk down from root, building the chain
      visited.clear();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);

        const loadResult = UISupport.loadConversation(currentId);
        if (!loadResult.success) break;

        const data = loadResult.data;
        chain.push({
          id: currentId,
          threadSequence: data.threadSequence || 1,
          savedAt: data.savedAt,
          messageCount: data.messages?.length || 0,
          hasMemory: !!data.memory
        });

        currentId = data.childThread;
      }

      return {
        success: true,
        data: {
          chain: chain,
          chainLength: chain.length
        }
      };

    } catch (error) {
      log(`[ConversationSearch] Get thread chain error: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ============================================================================
  // TOOL DEFINITION FOR CLAUDE
  // ============================================================================

  /**
   * Tool definition for Claude to search conversation history
   * This can be registered with the tool registry
   */
  const SEARCH_TOOL_DEFINITION = {
    name: 'search_conversation_history',
    description: 'Search across all archived conversations for specific topics, keywords, or decisions. Use when user references something from a previous conversation or when context might exist in history.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords, topic, or question'
        },
        search_type: {
          type: 'string',
          enum: ['keyword', 'date_range'],
          description: 'Type of search to perform (default: keyword)'
        },
        max_results: {
          type: 'integer',
          default: 5,
          description: 'Maximum number of results to return'
        }
      },
      required: ['query']
    }
  };

  // ============================================================================
  // EXPORTS
  // ============================================================================

  module.exports = {
    // Main search functions
    searchConversationHistory,
    searchThreadChain,
    getThreadChain,

    // Helper functions
    extractTextFromMessage,
    extractRelevantExcerpt,
    calculateRelevance,
    buildSearchableText,

    // Tool definition for Claude integration
    SEARCH_TOOL_DEFINITION,

    // Configuration
    SEARCH_CONFIG
  };
}

__defineModule__(_main);