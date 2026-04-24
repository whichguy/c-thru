function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  // Dependencies - lazy loaded to avoid circular dependencies
  // const DriveJournal = require('sheets-chat/DriveJournal');
  // const UISupport = require('sheets-chat/UISupport');
  // ClaudeApiUtils is loaded lazily in functions that need it

  /**
   * Get centralized configuration values
   * Uses ChatConstants for defaults with ConfigManager override support
   * @private
   */
  function _getConfigValue(key) {
    const { getConfig } = require('sheets-chat/ChatConstants');
    return getConfig(key);
  }

  /**
   * Configuration for thread continuation behavior
   * Now uses centralized ChatConstants for values
   * @type {Object}
   */
  const CONTINUATION_CONFIG = {
    // Token estimation (conservative due to 20-30% variance in heuristics)
    get tokenThreshold() { return _getConfigValue('CONTEXT_TOKEN_THRESHOLD'); },
    get warningThreshold() { return _getConfigValue('CONTEXT_WARNING_THRESHOLD'); },

    // Reactive fallback (CRITICAL - primary safety net)
    handleContextExceeded: true,  // Catch API "context too long" / "prompt is too long" errors

    // Message-based heuristic (backup when token estimation unreliable)
    get messageThreshold() { return _getConfigValue('MESSAGE_THRESHOLD'); },

    // Recent context to preserve verbatim
    get keepRecentTurns() { return _getConfigValue('KEEP_RECENT_TURNS'); },

    // Model for extraction (configurable - currently using Opus for quality)
    get extractionModel() { return _getConfigValue('THINKING_MODEL'); },

    // Note: GAS UrlFetchApp doesn't support custom timeouts (~30s per request)
    // These values document expected behavior but aren't enforced in code.
    // The 6-minute GAS execution limit is the practical constraint.
    // extractionTimeout: 30000,  // Not implemented - GAS limitation
    // summaryTimeout: 30000,     // Not implemented - GAS limitation

    // Memory limits
    get maxMemoryBlockTokens() { return _getConfigValue('MAX_MEMORY_BLOCK_TOKENS'); },
    get maxSummaryTokens() { return _getConfigValue('MAX_SUMMARY_TOKENS'); },

    // Memory maintenance
    get redistillationInterval() { return _getConfigValue('REDISTILLATION_INTERVAL'); },

    // Archive
    archiveToJournal: true        // Always save full history to Drive Journal
  };

  // ============================================================================
  // TOKEN ESTIMATION (Phase 1)
  // ============================================================================

  /**
   * Estimate total tokens for a Claude API request
   * GAS has no tokenizer - uses conservative heuristics
   *
   * @param {string} systemPrompt - The system prompt
   * @param {Array} messages - Array of message objects
   * @param {Array} tools - Array of tool definitions
   * @returns {number} Estimated token count with 20% safety margin
   */
  function estimateTokens(systemPrompt, messages, tools) {
    // System prompt: ~3.5 chars/token for structured content
    const systemTokens = systemPrompt ? Math.ceil(systemPrompt.length / 3.5) : 0;

    // Tools: JSON schema is token-dense (~3 chars/token)
    let toolTokens = 0;
    if (tools && tools.length > 0) {
      const toolsJson = JSON.stringify(tools);
      toolTokens = Math.ceil(toolsJson.length / 3);
    }

    // Messages: varies by content type
    let messageTokens = 0;
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        messageTokens += estimateMessageTokens(msg);
      }
    }

    // Add 20% safety margin for estimation error
    const estimated = systemTokens + toolTokens + messageTokens;
    const withMargin = Math.ceil(estimated * 1.2);

    log(`[ThreadContinuation] Token estimate: system=${systemTokens}, tools=${toolTokens}, messages=${messageTokens}, total=${estimated}, withMargin=${withMargin}`);

    return withMargin;
  }

  /**
   * Estimate tokens for a single message
   *
   * @param {Object} msg - Message object with role and content
   * @returns {number} Estimated token count
   */
  function estimateMessageTokens(msg) {
    if (!msg || !msg.content) return 0;

    // Simple string content
    if (typeof msg.content === 'string') {
      return Math.ceil(msg.content.length / 4);
    }

    // Content blocks array (text, images, tool_use, tool_result)
    if (!Array.isArray(msg.content)) return 0;

    let tokens = 0;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        tokens += Math.ceil(block.text.length / 4);
      } else if (block.type === 'image') {
        // Images token estimate varies by size - use centralized constant
        tokens += _getConfigValue('IMAGE_TOKEN_ESTIMATE');
      } else if (block.type === 'tool_use' || block.type === 'tool_result') {
        // Tool blocks are JSON-dense
        const json = JSON.stringify(block);
        tokens += Math.ceil(json.length / 3);
      } else if (block.type === 'thinking' && block.thinking) {
        // Extended thinking tokens - don't count as they're not included in context
        // Just skip
      } else {
        // Unknown block type - estimate conservatively
        const json = JSON.stringify(block);
        tokens += Math.ceil(json.length / 4);
      }
    }

    return tokens;
  }

  // ============================================================================
  // DETECTION (Phase 1)
  // ============================================================================

  /**
   * Determine if thread continuation should be triggered
   *
   * @param {number} tokenCount - Estimated token count
   * @param {number} messageCount - Number of messages in conversation
   * @param {Object} config - Optional config override
   * @returns {boolean} True if continuation should be triggered
   */
  function shouldContinue(tokenCount, messageCount, config = CONTINUATION_CONFIG) {
    const cfg = { ...CONTINUATION_CONFIG, ...config };

    // Primary check: token threshold
    if (tokenCount >= cfg.tokenThreshold) {
      log(`[ThreadContinuation] Token threshold exceeded: ${tokenCount} >= ${cfg.tokenThreshold}`);
      return true;
    }

    // Secondary check: message count (fallback for when token estimation is unreliable)
    if (messageCount >= cfg.messageThreshold) {
      log(`[ThreadContinuation] Message threshold exceeded: ${messageCount} >= ${cfg.messageThreshold}`);
      return true;
    }

    // Warning: approaching threshold
    if (tokenCount >= cfg.warningThreshold) {
      log(`[ThreadContinuation] Warning: Approaching token threshold: ${tokenCount} / ${cfg.tokenThreshold}`);
    }

    return false;
  }

  /**
   * Check if an error indicates context was exceeded
   * Delegates to ClaudeApiUtils for consistent error detection
   *
   * @param {Error|Object} error - Error object from API call
   * @returns {boolean} True if this is a context exceeded error
   */
  function isContextExceededError(error) {
    // Delegate to ClaudeApiUtils which has better nested error handling
    const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');
    return ClaudeApiUtils.isContextExceededError(error);
  }

  /**
   * Get the most recent N user/assistant turn pairs
   *
   * @param {Array} messages - Full message array
   * @param {number} turnCount - Number of turn pairs to keep
   * @returns {Array} Recent messages (up to turnCount * 2 messages)
   */
  function getRecentTurns(messages, turnCount = 5) {
    if (!messages || messages.length === 0) return [];

    const turnMessages = [];
    let userTurnsSeen = 0;

    // Walk backwards through messages, collecting until we have enough turns
    for (let i = messages.length - 1; i >= 0 && userTurnsSeen < turnCount; i--) {
      const msg = messages[i];
      turnMessages.unshift(msg);

      // Count user messages to track turn pairs
      if (msg.role === 'user') {
        userTurnsSeen++;
      }
    }

    return turnMessages;
  }

  /**
   * Generate a unique thread ID
   *
   * @returns {string} Thread ID in format: thread-{timestamp}-{random}
   */
  function generateThreadId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `thread-${timestamp}-${random}`;
  }

  // ============================================================================
  // GENERATIONAL MEMORY STRUCTURE
  // ============================================================================

  /**
   * Get generational memory configuration from ChatConstants
   * @returns {Object} Memory generation limits and budgets
   */
  function getMemoryGenerationConfig() {
    return {
      current: {
        maxFacts: _getConfigValue('MEMORY_GEN0_MAX_FACTS'),
        maxEntityCategories: _getConfigValue('MEMORY_GEN0_MAX_ENTITY_CATEGORIES'),
        tokenBudget: _getConfigValue('MEMORY_GEN0_TOKEN_BUDGET')
      },
      recent: {
        maxEpisodes: _getConfigValue('MEMORY_GEN1_MAX_EPISODES'),
        factsPerEpisode: _getConfigValue('MEMORY_GEN1_FACTS_PER_EPISODE'),
        tokenBudget: _getConfigValue('MEMORY_GEN1_TOKEN_BUDGET')
      },
      archive: {
        maxGistLength: _getConfigValue('MEMORY_GEN2_MAX_GIST_LENGTH'),
        maxImportantFacts: _getConfigValue('MEMORY_GEN2_MAX_IMPORTANT_FACTS'),
        tokenBudget: _getConfigValue('MEMORY_GEN2_TOKEN_BUDGET')
      },
      totalBudget: _getConfigValue('MEMORY_TOTAL_BUDGET_TOKENS')
    };
  }

  /**
   * Estimate token count for a memory object
   * Uses conservative heuristics (~4 chars per token for JSON)
   * 
   * @param {Object} memory - Memory object (flat or generational)
   * @returns {number} Estimated token count
   */
  function estimateMemoryTokens(memory) {
    if (!memory) return 0;
    
    try {
      const json = JSON.stringify(memory);
      // JSON is token-dense, use ~3 chars/token for conservative estimate
      return Math.ceil(json.length / 3);
    } catch (e) {
      log(`[ThreadContinuation] Error estimating memory tokens: ${e.message}`);
      return 0;
    }
  }

  /**
   * Truncate memory to fit within a token budget
   * Uses recursive strategy: archive → recent → current
   * 
   * @param {Object} memory - Memory object to truncate
   * @param {number} maxTokens - Maximum token budget
   * @returns {Object} Truncated memory that fits budget
   */
  function truncateMemory(memory, maxTokens) {
    if (!memory) return { entities: {}, facts: [], currentGoal: null };
    
    let tokens = estimateMemoryTokens(memory);
    
    if (tokens <= maxTokens) {
      return memory; // Already under budget
    }
    
    log(`[ThreadContinuation] Truncating memory: ${tokens} tokens → ${maxTokens} budget`);
    
    // Make a deep copy to avoid mutating original
    const result = JSON.parse(JSON.stringify(memory));
    const config = getMemoryGenerationConfig();
    
    // Check if this is generational memory (has current/recent/archive)
    const isGenerational = result.current !== undefined || result.recent !== undefined;
    
    if (isGenerational) {
      // Strategy 1: Prune archive gist
      if (result.archive && result.archive.gist && result.archive.gist.length > 200) {
        result.archive.gist = result.archive.gist.substring(result.archive.gist.length - 200);
        const sentenceStart = result.archive.gist.indexOf('. ');
        if (sentenceStart > 0) result.archive.gist = result.archive.gist.substring(sentenceStart + 2);
        tokens = estimateMemoryTokens(result);
        if (tokens <= maxTokens) return result;
      }
      
      // Strategy 2: Remove archive important facts
      if (result.archive && result.archive.importantFacts && result.archive.importantFacts.length > 2) {
        result.archive.importantFacts = result.archive.importantFacts.slice(-2);
        tokens = estimateMemoryTokens(result);
        if (tokens <= maxTokens) return result;
      }
      
      // Strategy 3: Delete entire archive
      if (result.archive) {
        result.archive = { gist: '', importantFacts: [] };
        tokens = estimateMemoryTokens(result);
        if (tokens <= maxTokens) return result;
      }
      
      // Strategy 4: Remove oldest recent episode
      while (result.recent && result.recent.episodes && result.recent.episodes.length > 1 && tokens > maxTokens) {
        result.recent.episodes.pop();
        tokens = estimateMemoryTokens(result);
      }
      
      // Strategy 5: Keep only 1 recent episode
      if (result.recent && result.recent.episodes && result.recent.episodes.length > 0 && tokens > maxTokens) {
        result.recent.episodes = [result.recent.episodes[0]];
        tokens = estimateMemoryTokens(result);
      }
      
      // Strategy 6: Delete recent episodes entirely
      if (result.recent && tokens > maxTokens) {
        result.recent = { episodes: [] };
        tokens = estimateMemoryTokens(result);
      }
      
      // Strategy 7: Reduce current facts
      if (result.current && result.current.facts && result.current.facts.length > 5 && tokens > maxTokens) {
        result.current.facts = result.current.facts.slice(-5);
        tokens = estimateMemoryTokens(result);
      }
      
      // Strategy 8: Emergency - only 3 facts and 2 entity categories
      if (result.current && tokens > maxTokens) {
        if (result.current.facts) result.current.facts = result.current.facts.slice(-3);
        if (result.current.entities) {
          const keys = Object.keys(result.current.entities);
          if (keys.length > 2) {
            const kept = {};
            keys.slice(-2).forEach(k => kept[k] = result.current.entities[k]);
            result.current.entities = kept;
          }
        }
        tokens = estimateMemoryTokens(result);
      }
    } else {
      // Flat memory structure (legacy) - apply simpler truncation
      
      // Strategy 1: Reduce facts
      if (result.facts && result.facts.length > 10) {
        result.facts = result.facts.slice(-10);
        tokens = estimateMemoryTokens(result);
        if (tokens <= maxTokens) return result;
      }
      
      // Strategy 2: Further reduce facts
      if (result.facts && result.facts.length > 5) {
        result.facts = result.facts.slice(-5);
        tokens = estimateMemoryTokens(result);
        if (tokens <= maxTokens) return result;
      }
      
      // Strategy 3: Prune entity categories
      if (result.entities) {
        const entityKeys = Object.keys(result.entities);
        while (entityKeys.length > 3 && tokens > maxTokens) {
          delete result.entities[entityKeys.shift()];
          tokens = estimateMemoryTokens(result);
        }
      }
      
      // Strategy 4: Emergency - only 3 facts
      if (result.facts && tokens > maxTokens) {
        result.facts = result.facts.slice(-3);
        tokens = estimateMemoryTokens(result);
      }
      
      // Strategy 5: Emergency - only 2 entity categories
      if (result.entities && tokens > maxTokens) {
        const keys = Object.keys(result.entities);
        if (keys.length > 2) {
          const kept = {};
          keys.slice(-2).forEach(k => kept[k] = result.entities[k]);
          result.entities = kept;
          tokens = estimateMemoryTokens(result);
        }
      }
    }
    
    log(`[ThreadContinuation] Memory truncated to ${tokens} tokens (budget: ${maxTokens})`);
    return result;
  }

  /**
   * Compress current generation (Gen 0) to episode summary (Gen 1)
   * 
   * @param {Object} current - Current generation memory
   * @returns {Object} Episode summary for recent array
   */
  function compressToEpisode(current) {
    if (!current) return { summary: '', keyDecisions: [], keyEntities: [] };
    
    const config = getMemoryGenerationConfig();
    
    return {
      summary: current.currentGoal || 'Worked on tasks',
      keyDecisions: extractKeyDecisions(current.entities).slice(0, 3),
      keyEntities: extractKeyEntities(current.entities).slice(0, config.recent.factsPerEpisode)
    };
  }

  /**
   * Extract key decisions from entities
   * @private
   */
  function extractKeyDecisions(entities) {
    if (!entities) return [];
    
    // Extract from entities.decisions if present
    if (entities.decisions) {
      if (Array.isArray(entities.decisions)) {
        return entities.decisions.slice(0, 3);
      }
      if (typeof entities.decisions === 'object') {
        return Object.values(entities.decisions).slice(0, 3);
      }
    }
    
    return [];
  }

  /**
   * Extract key entity identifiers for summary
   * @private
   */
  function extractKeyEntities(entities) {
    if (!entities) return [];
    
    const keys = [];
    
    for (const [category, items] of Object.entries(entities)) {
      if (category === 'decisions') continue; // Already handled
      
      if (typeof items === 'object' && items !== null) {
        if (Array.isArray(items)) {
          // Array of values - take first few
          items.slice(0, 2).forEach(item => {
            if (typeof item === 'string') keys.push(`${category}: ${item}`);
            else if (item && item.id) keys.push(`${category}: ${item.id}`);
          });
        } else {
          // Object with named properties
          for (const [name, value] of Object.entries(items)) {
            if (value && value.id) keys.push(`${name}: ${value.id}`);
            else if (typeof value === 'string') keys.push(`${name}: ${value}`);
            if (keys.length >= 5) break;
          }
        }
      }
      if (keys.length >= 5) break;
    }
    
    return keys;
  }

  /**
   * Merge episode into archive (Gen 1 → Gen 2)
   * 
   * @param {Object} archive - Current archive object
   * @param {Object} episode - Episode to merge in
   * @returns {Object} Updated archive
   */
  function mergeIntoArchive(archive, episode) {
    const config = getMemoryGenerationConfig();
    
    // Start with existing archive or empty
    let newGist = (archive && archive.gist) || '';
    const existingFacts = (archive && archive.importantFacts) || [];
    
    // Append episode summary to gist
    if (episode && episode.summary) {
      if (newGist) newGist += ' ';
      newGist += episode.summary + '.';
    }
    
    // Trim gist to max length, keeping from end
    if (newGist.length > config.archive.maxGistLength) {
      newGist = newGist.substring(newGist.length - config.archive.maxGistLength);
      // Start from sentence boundary if possible
      const sentenceStart = newGist.indexOf('. ');
      if (sentenceStart > 0 && sentenceStart < 50) {
        newGist = newGist.substring(sentenceStart + 2);
      }
    }
    
    // Merge important facts/entities, keeping most recent
    const newFacts = [
      ...existingFacts,
      ...((episode && episode.keyEntities) || [])
    ].slice(-config.archive.maxImportantFacts);
    
    return {
      gist: newGist,
      importantFacts: newFacts
    };
  }

  /**
   * Demote memory from one generation to the next
   * Shifts: current → recent[0], oldest recent → archive
   * 
   * @param {Object} memory - Current generational memory (or flat memory)
   * @returns {Object} Memory with generations shifted down
   */
  function demoteGenerations(memory) {
    const config = getMemoryGenerationConfig();
    
    // Initialize result with empty generations
    const result = {
      current: { entities: {}, facts: [], currentGoal: null },
      recent: { episodes: [] },
      archive: { gist: '', importantFacts: [] }
    };
    
    // Handle flat memory structure (legacy or first continuation)
    if (!memory || (!memory.current && !memory.recent)) {
      // Convert flat memory to current generation
      if (memory && (memory.facts || memory.entities)) {
        const episode = compressToEpisode(memory);
        result.recent.episodes.push(episode);
      }
      return result;
    }
    
    // Copy existing recent episodes
    if (memory.recent && memory.recent.episodes) {
      result.recent.episodes = [...memory.recent.episodes];
    }
    
    // Copy existing archive
    if (memory.archive) {
      result.archive = { ...memory.archive };
      if (memory.archive.importantFacts) {
        result.archive.importantFacts = [...memory.archive.importantFacts];
      }
    }
    
    // Demote current → recent episode (if current has content)
    if (memory.current && 
        ((memory.current.facts && memory.current.facts.length > 0) || 
         (memory.current.entities && Object.keys(memory.current.entities).length > 0))) {
      const episode = compressToEpisode(memory.current);
      result.recent.episodes.unshift(episode);
    }
    
    // Demote oldest recent → archive (if over limit)
    while (result.recent.episodes.length > config.recent.maxEpisodes) {
      const oldest = result.recent.episodes.pop();
      result.archive = mergeIntoArchive(result.archive, oldest);
    }
    
    return result;
  }

  /**
   * Enforce total memory budget with recursive compaction
   * 
   * @param {Object} memory - Generational memory object
   * @returns {Object} Memory that fits within total budget
   */
  function enforceMemoryBudget(memory) {
    const config = getMemoryGenerationConfig();
    let tokens = estimateMemoryTokens(memory);
    
    if (tokens <= config.totalBudget) {
      log(`[ThreadContinuation] Memory within budget: ${tokens}/${config.totalBudget} tokens`);
      return memory;
    }
    
    log(`[ThreadContinuation] Memory over budget: ${tokens}/${config.totalBudget} tokens, compacting...`);
    
    // Use truncateMemory for recursive compaction
    return truncateMemory(memory, config.totalBudget);
  }

  // ============================================================================
  // TOOL RESULT EXTRACTION
  // ============================================================================

  /**
   * Pattern definitions for detecting valuable content in tool results
   * @private
   */
  const TOOL_RESULT_PATTERNS = {
    // GAS script IDs (44-57 chars - can vary)
    scriptId: /scriptId["\s:=]+["']?([a-zA-Z0-9_-]{40,60})["']?/i,
    
    // Spreadsheet IDs (44-57 chars)
    spreadsheetId: /spreadsheetId["\s:=]+["']?([a-zA-Z0-9_-]{40,60})["']?/i,
    
    // Numeric project IDs
    projectId: /projectId["\s:=]+["']?(\d{10,})["']?/i,
    
    // API keys (various formats)
    apiKey: /apiKey["\s:=]+["']?([a-zA-Z0-9_-]{20,})["']?/i,
    
    // Connection strings
    connectionString: /connectionString["\s:=]+["']?([^"'\s]+)["']?/i,
    
    // Google/Anthropic URLs
    apiUrls: /https?:\/\/[^\s"']+\.(googleapis|google|anthropic)\.[^\s"'<>]+/gi,
    
    // Web app URLs
    webAppUrl: /https?:\/\/script\.google\.com\/macros\/s\/[^\s"'<>]+/gi,
    
    // File paths
    filePaths: /\/[a-zA-Z0-9_\-\/]+\.(gs|js|ts|json|html)/gi
  };

  /**
   * Detect if content contains project identifiers worth preserving
   * @param {string|Object} content - Content to check
   * @returns {boolean} True if contains identifiers
   */
  function containsProjectIdentifiers(content) {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    
    return TOOL_RESULT_PATTERNS.scriptId.test(str) ||
           TOOL_RESULT_PATTERNS.spreadsheetId.test(str) ||
           TOOL_RESULT_PATTERNS.projectId.test(str) ||
           TOOL_RESULT_PATTERNS.apiKey.test(str) ||
           TOOL_RESULT_PATTERNS.connectionString.test(str) ||
           TOOL_RESULT_PATTERNS.apiUrls.test(str) ||
           TOOL_RESULT_PATTERNS.webAppUrl.test(str);
  }

  /**
   * Detect if content looks like configuration
   * @param {string|Object} content - Content to check
   * @returns {boolean} True if looks like config
   */
  function looksLikeConfig(content) {
    if (typeof content !== 'string') return true; // Objects are config-like
    
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      // Check for key=value patterns
      return /^\s*[A-Z_]+\s*[=:]/m.test(content);
    }
  }

  /**
   * Detect if content contains API response data
   * @param {string|Object} content - Content to check
   * @returns {boolean} True if contains API data
   */
  function containsApiData(content) {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    
    // Common API response patterns
    return (/"id"\s*:/i.test(str) && /"(success|status|result)"\s*:/i.test(str)) ||
           /"(webAppUrl|deploymentId|versionNumber)"\s*:/i.test(str) ||
           /https?:\/\/[^\s"']+\/exec/i.test(str);
  }

  /**
   * Extract identifiers from content
   * @param {string|Object} content - Content to extract from
   * @returns {Object} Extracted identifiers
   */
  function extractIdentifiers(content) {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    const identifiers = {};
    
    // Reset regex lastIndex for global patterns
    TOOL_RESULT_PATTERNS.apiUrls.lastIndex = 0;
    TOOL_RESULT_PATTERNS.webAppUrl.lastIndex = 0;
    TOOL_RESULT_PATTERNS.filePaths.lastIndex = 0;
    
    // Extract scriptIds
    const scriptIdMatch = str.match(TOOL_RESULT_PATTERNS.scriptId);
    if (scriptIdMatch) identifiers.scriptId = scriptIdMatch[1];
    
    // Extract spreadsheetIds
    const sheetIdMatch = str.match(TOOL_RESULT_PATTERNS.spreadsheetId);
    if (sheetIdMatch) identifiers.spreadsheetId = sheetIdMatch[1];
    
    // Extract project IDs
    const projectIdMatch = str.match(TOOL_RESULT_PATTERNS.projectId);
    if (projectIdMatch) identifiers.projectId = projectIdMatch[1];
    
    // Extract URLs (combine API URLs and web app URLs)
    const apiUrlMatches = str.match(TOOL_RESULT_PATTERNS.apiUrls) || [];
    const webAppMatches = str.match(TOOL_RESULT_PATTERNS.webAppUrl) || [];
    const allUrls = [...new Set([...apiUrlMatches, ...webAppMatches])];
    if (allUrls.length > 0) identifiers.urls = allUrls.slice(0, 5);
    
    // Extract file paths
    const fileMatches = str.match(TOOL_RESULT_PATTERNS.filePaths) || [];
    if (fileMatches.length > 0) identifiers.filePaths = [...new Set(fileMatches)].slice(0, 5);
    
    return identifiers;
  }

  /**
   * Extract config values from content
   * @param {string|Object} content - Content to extract from
   * @returns {Object} Extracted config values
   */
  function extractConfigValues(content) {
    const config = {};
    
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      
      // Extract known important config keys
      const importantKeys = ['scriptId', 'spreadsheetId', 'projectId', 'webAppUrl', 
                             'deploymentId', 'versionNumber', 'accessUrl'];
      
      for (const key of importantKeys) {
        if (parsed[key]) config[key] = parsed[key];
      }
      
      // Look for nested config
      if (parsed.config || parsed.settings) {
        config.nestedConfig = parsed.config || parsed.settings;
      }
    } catch {
      // Not JSON, try key-value extraction
      const str = String(content);
      const kvPattern = /([A-Z_]+)\s*[=:]\s*["']?([^"'\n]+)["']?/g;
      let match;
      while ((match = kvPattern.exec(str)) !== null) {
        config[match[1]] = match[2].trim();
      }
    }
    
    return config;
  }

  /**
   * Extract API data (IDs, URLs) from content
   * @param {string|Object} content - Content to extract from
   * @returns {Object} Extracted API data
   */
  function extractApiData(content) {
    const data = {};
    
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      
      // Extract common API response fields
      if (parsed.id) data.id = parsed.id;
      if (parsed.scriptId) data.scriptId = parsed.scriptId;
      if (parsed.webAppUrl) data.webAppUrl = parsed.webAppUrl;
      if (parsed.deploymentId) data.deploymentId = parsed.deploymentId;
      if (parsed.versionNumber) data.versionNumber = parsed.versionNumber;
      if (parsed.url) data.url = parsed.url;
      
      // Check for nested results
      if (parsed.result && typeof parsed.result === 'object') {
        const nestedData = extractApiData(parsed.result);
        Object.assign(data, nestedData);
      }
    } catch {
      // Not JSON, extract URLs directly
      const str = String(content);
      const urls = str.match(/https?:\/\/[^\s"'<>]+/g);
      if (urls) data.urls = [...new Set(urls)].slice(0, 3);
    }
    
    return data;
  }

  /**
   * Extract valuable content from tool results in messages
   * @param {Object} message - Message with role and content
   * @returns {Array} Extracted valuable content snippets
   */
  function extractToolResultValues(message) {
    // Only process assistant messages that may contain tool results
    if (!message || typeof message.content === 'string') {
      return [];
    }
    
    const valuable = [];
    const contentBlocks = Array.isArray(message.content) ? message.content : [message.content];
    
    for (const block of contentBlocks) {
      if (!block) continue;
      
      // Tool result blocks
      if (block.type === 'tool_result' || block.type === 'tool_use') {
        const result = block.content || block.output || block.input || '';
        const toolName = block.name || block.tool_name || 'tool';
        
        // Pattern 1: File contents with identifiers
        if (containsProjectIdentifiers(result)) {
          valuable.push({
            type: 'identifiers',
            source: toolName,
            content: extractIdentifiers(result)
          });
        }
        
        // Pattern 2: Configuration/JSON with settings
        if (looksLikeConfig(result)) {
          const configVals = extractConfigValues(result);
          if (Object.keys(configVals).length > 0) {
            valuable.push({
              type: 'config',
              source: toolName,
              content: configVals
            });
          }
        }
        
        // Pattern 3: API responses with IDs/URLs
        if (containsApiData(result)) {
          const apiData = extractApiData(result);
          if (Object.keys(apiData).length > 0) {
            valuable.push({
              type: 'api_data',
              source: toolName,
              content: apiData
            });
          }
        }
      }
    }
    
    return valuable;
  }

  /**
   * Extract tool results from all messages
   * @param {Array} messages - Array of messages
   * @returns {Array} Aggregated tool result values (limited by config)
   */
  function extractToolResultsFromMessages(messages) {
    if (!messages || !Array.isArray(messages)) return [];
    
    const maxItems = _getConfigValue('MAX_TOOL_RESULT_ITEMS');
    const allValues = [];
    
    // Check more messages for tool results (they may be early in conversation)
    for (const m of messages.slice(-50)) {
      const values = extractToolResultValues(m);
      allValues.push(...values);
    }
    
    // Deduplicate by content hash and limit
    const seen = new Set();
    const unique = [];
    
    for (const item of allValues) {
      const hash = JSON.stringify(item.content);
      if (!seen.has(hash)) {
        seen.add(hash);
        unique.push(item);
      }
      if (unique.length >= maxItems) break;
    }
    
    return unique;
  }

  // ============================================================================
  // CONTRADICTION DETECTION & VALIDATION
  // ============================================================================

  /**
   * Get compiled stale language regex patterns
   * @returns {Array<RegExp>} Array of compiled regex patterns
   * @private
   */
  function _getStaleLanguagePatterns() {
    const patterns = _getConfigValue('STALE_LANGUAGE_PATTERNS');
    return patterns.map(p => new RegExp(`\\b${p}\\b`, 'i'));
  }

  /**
   * Multi-layer contradiction validation
   * Based on RAG contradiction detection research
   * 
   * @param {Object} newMemory - Newly extracted memory
   * @param {Object} existingMemory - Existing memory from previous threads
   * @returns {Object} Validation result with memory and issues
   */
  function validateMemoryContradictions(newMemory, existingMemory) {
    const issues = [];
    
    // === LAYER 1: Stale Language Detection ===
    const stalePatterns = _getStaleLanguagePatterns();
    
    const allFacts = [];
    
    // Check current facts (generational structure)
    if (newMemory.current && newMemory.current.facts) {
      allFacts.push(...newMemory.current.facts.map(f => ({ fact: f, location: 'current.facts' })));
    }
    // Check flat facts (legacy structure)
    if (newMemory.facts && !newMemory.current) {
      allFacts.push(...newMemory.facts.map(f => ({ fact: f, location: 'facts' })));
    }
    
    for (const { fact, location } of allFacts) {
      if (typeof fact !== 'string') continue;
      
      for (const pattern of stalePatterns) {
        if (pattern.test(fact)) {
          issues.push({
            type: 'STALE_LANGUAGE',
            severity: 'HIGH',
            fact: fact,
            location: location,
            pattern: pattern.source,
            action: 'REMOVE or REWRITE to final state only'
          });
          break; // Only report first matching pattern per fact
        }
      }
    }
    
    // === LAYER 2: Cross-Memory Contradiction ===
    // Check if new decisions contradict existing decisions
    const newDecisions = newMemory.current?.entities?.decisions || 
                         newMemory.entities?.decisions || {};
    const oldDecisions = existingMemory?.current?.entities?.decisions || 
                         existingMemory?.entities?.decisions || {};
    
    for (const [category, newValue] of Object.entries(newDecisions)) {
      const oldValue = oldDecisions[category];
      if (oldValue && oldValue !== newValue && typeof oldValue === 'string') {
        // Decision changed - ensure old value doesn't appear in facts
        const oldLower = oldValue.toLowerCase();
        
        for (const { fact, location } of allFacts) {
          if (typeof fact === 'string' && fact.toLowerCase().includes(oldLower)) {
            issues.push({
              type: 'SUPERSEDED_REFERENCE',
              severity: 'MEDIUM',
              fact: fact,
              location: location,
              oldValue: oldValue,
              newValue: newValue,
              action: `Decision changed from "${oldValue}" to "${newValue}" but fact still references old value`
            });
          }
        }
      }
    }
    
    // === LAYER 3: Anchor Consistency ===
    // Anchors should NEVER change unless explicitly updated
    const newAnchors = newMemory.current?.entities?.anchors || 
                       newMemory.entities?.anchors || {};
    const oldAnchors = existingMemory?.current?.entities?.anchors || 
                       existingMemory?.entities?.anchors || {};
    
    for (const [key, oldValue] of Object.entries(oldAnchors)) {
      if (oldValue && !newAnchors[key]) {
        issues.push({
          type: 'ANCHOR_LOSS',
          severity: 'CRITICAL',
          key: key,
          oldValue: oldValue,
          action: 'RESTORE - Anchors must never be lost'
        });
      }
    }
    
    // === LAYER 4: Duplicate Fact Detection ===
    const seenFacts = new Set();
    for (const { fact, location } of allFacts) {
      if (typeof fact !== 'string') continue;
      
      const normalized = fact.toLowerCase().trim();
      if (seenFacts.has(normalized)) {
        issues.push({
          type: 'DUPLICATE_FACT',
          severity: 'LOW',
          fact: fact,
          location: location,
          action: 'REMOVE duplicate'
        });
      } else {
        seenFacts.add(normalized);
      }
    }
    
    // === LOGGING ===
    if (issues.length > 0) {
      log(`[ThreadContinuation] Contradiction validation found ${issues.length} issues:`);
      for (const issue of issues.slice(0, 5)) { // Log first 5
        log(`  [${issue.severity}] ${issue.type}: ${issue.action.substring(0, 80)}`);
      }
      if (issues.length > 5) {
        log(`  ... and ${issues.length - 5} more issues`);
      }
    }
    
    return {
      memory: newMemory,
      issues: issues,
      hasHighSeverity: issues.some(i => i.severity === 'HIGH' || i.severity === 'CRITICAL'),
      hasCritical: issues.some(i => i.severity === 'CRITICAL')
    };
  }

  /**
   * Auto-repair critical contradiction issues
   * Only repairs ANCHOR_LOSS automatically; removes stale language facts
   * 
   * @param {Object} validationResult - Result from validateMemoryContradictions
   * @param {Object} existingMemory - Existing memory for restoring anchors
   * @returns {Object} Repaired memory
   */
  function repairMemoryContradictions(validationResult, existingMemory) {
    const { memory, issues } = validationResult;
    
    // Track repairs
    const repairs = [];
    
    for (const issue of issues) {
      if (issue.type === 'ANCHOR_LOSS') {
        // Auto-restore lost anchors
        if (memory.current) {
          if (!memory.current.entities) memory.current.entities = {};
          if (!memory.current.entities.anchors) memory.current.entities.anchors = {};
          memory.current.entities.anchors[issue.key] = issue.oldValue;
        } else {
          if (!memory.entities) memory.entities = {};
          if (!memory.entities.anchors) memory.entities.anchors = {};
          memory.entities.anchors[issue.key] = issue.oldValue;
        }
        repairs.push(`Restored anchor: ${issue.key}`);
      }
      
      if (issue.type === 'STALE_LANGUAGE' && issue.severity === 'HIGH') {
        // Remove facts with stale language
        if (issue.location === 'current.facts' && memory.current && memory.current.facts) {
          memory.current.facts = memory.current.facts.filter(f => f !== issue.fact);
          repairs.push(`Removed stale fact: "${issue.fact.substring(0, 40)}..."`);
        } else if (issue.location === 'facts' && memory.facts) {
          memory.facts = memory.facts.filter(f => f !== issue.fact);
          repairs.push(`Removed stale fact: "${issue.fact.substring(0, 40)}..."`);
        }
      }
      
      if (issue.type === 'DUPLICATE_FACT' && issue.severity === 'LOW') {
        // Remove duplicate facts (keep first occurrence)
        if (issue.location === 'current.facts' && memory.current && memory.current.facts) {
          const idx = memory.current.facts.lastIndexOf(issue.fact);
          if (idx > 0) {
            memory.current.facts.splice(idx, 1);
            repairs.push(`Removed duplicate fact`);
          }
        } else if (issue.location === 'facts' && memory.facts) {
          const idx = memory.facts.lastIndexOf(issue.fact);
          if (idx > 0) {
            memory.facts.splice(idx, 1);
            repairs.push(`Removed duplicate fact`);
          }
        }
      }
    }
    
    if (repairs.length > 0) {
      log(`[ThreadContinuation] Auto-repaired ${repairs.length} issue(s): ${repairs.slice(0, 3).join(', ')}${repairs.length > 3 ? '...' : ''}`);
    }
    
    return memory;
  }

  /**
   * Deduplicate facts based on similarity
   * Removes near-duplicate facts from array
   * 
   * @param {Array<string>} facts - Array of facts to deduplicate
   * @returns {Array<string>} Deduplicated facts
   */
  function deduplicateFacts(facts) {
    if (!facts || !Array.isArray(facts)) return [];
    
    const unique = [];
    
    for (const fact of facts) {
      if (typeof fact !== 'string') continue;
      
      const factLower = fact.toLowerCase().trim();
      
      // Check for exact or substring duplicates
      const isDuplicate = unique.some(existing => {
        const existingLower = existing.toLowerCase().trim();
        
        // Exact match
        if (factLower === existingLower) return true;
        
        // Substring containment (one contains the other)
        if (factLower.length > 20 && existingLower.length > 20) {
          if (factLower.includes(existingLower.substring(0, 20))) return true;
          if (existingLower.includes(factLower.substring(0, 20))) return true;
        }
        
        return false;
      });
      
      if (!isDuplicate) {
        unique.push(fact);
      }
    }
    
    return unique;
  }

  // ============================================================================
  // MEMORY EXTRACTION (Phase 2)
  // ============================================================================

  /**
   * Extract semantic memory from messages using LLM
   * Uses generational memory with episode decay:
   * - Demotes existing generations (current → recent → archive)
   * - Extracts new current generation from messages
   * - Validates for contradictions and repairs critical issues
   * - Deduplicates facts
   * - Enforces total memory budget
   *
   * @param {Array} messages - Messages to extract memory from
   * @param {Object} existingMemory - Existing memory to merge with (flat or generational)
   * @returns {Object} Extracted memory block (generational structure)
   */
  function extractMemory(messages, existingMemory) {
    // 1. Demote existing generations
    const demotedMemory = demoteGenerations(existingMemory);
    
    log(`[ThreadContinuation] Demoted memory: ${demotedMemory.recent.episodes.length} recent episodes, archive gist ${demotedMemory.archive.gist.length} chars`);
    
    // 2. Extract new current generation from messages using LLM
    // Pass demoted memory as context so LLM sees what's already captured
    const extractedCurrent = extractMemoryWithLLM(messages, demotedMemory);
    
    // 3. Build generational result
    // The LLM returns flat memory (entities/facts/currentGoal)
    // This becomes the new current generation
    let result = {
      current: {
        entities: extractedCurrent.entities || {},
        facts: extractedCurrent.facts || [],
        currentGoal: extractedCurrent.currentGoal || null
      },
      recent: demotedMemory.recent,
      archive: demotedMemory.archive
    };
    
    // 4. Validate for contradictions (NEW - multi-layer defense)
    const validation = validateMemoryContradictions(result, existingMemory);
    
    // 5. Auto-repair critical issues (NEW)
    if (validation.hasCritical || validation.hasHighSeverity) {
      result = repairMemoryContradictions(validation, existingMemory);
    }
    
    // 6. Deduplicate facts (NEW)
    if (result.current && result.current.facts) {
      result.current.facts = deduplicateFacts(result.current.facts);
    }
    
    // 7. Log if issues remain after repair
    if (validation.hasHighSeverity) {
      const unrepairedHigh = validation.issues.filter(i => 
        (i.severity === 'HIGH' || i.severity === 'CRITICAL') && 
        i.type !== 'ANCHOR_LOSS' && i.type !== 'STALE_LANGUAGE' && i.type !== 'DUPLICATE_FACT'
      );
      if (unrepairedHigh.length > 0) {
        log(`[ThreadContinuation] WARNING: ${unrepairedHigh.length} high-severity issue(s) may remain after repair`);
      }
    }
    
    // 8. Enforce total memory budget with recursive compaction
    return enforceMemoryBudget(result);
  }

  /**
   * Extract memory using Claude LLM API
   * Uses ClaudeApiUtils for robust retry logic and error handling
   *
   * @param {Array} messages - Messages to extract memory from
   * @param {Object} existingMemory - Existing memory to merge with
   * @returns {Object} Extracted memory block
   */
  function extractMemoryWithLLM(messages, existingMemory) {
    const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');

    const extractionPrompt = buildExtractionPrompt(messages, existingMemory);

    log(`[ThreadContinuation] Calling LLM for memory extraction (${messages.length} msgs, ${extractionPrompt.length} chars)`);

    // Use ClaudeApiUtils.completeJSON for JSON response handling
    const result = ClaudeApiUtils.completeJSON(extractionPrompt, {
      model: CONTINUATION_CONFIG.extractionModel,
      maxTokens: 1024,
      retryConfig: {
        maxRetries: 2,  // Fewer retries for extraction (non-critical path)
        baseDelayMs: 1000,
        maxDelayMs: 10000
      }
    });

    if (!result.success) {
      throw new Error(result.error || 'Memory extraction failed');
    }

    // Merge extracted memory with existing
    const merged = mergeMemory(existingMemory, result.json || {});

    log(`[ThreadContinuation] Memory extraction complete: ${Object.keys(merged.entities || {}).length} entities, ${(merged.facts || []).length} facts`);

    return merged;
  }

  /**
   * Rule-based memory extraction fallback
   * Uses regex patterns to extract common entities
   *
   * @param {Array} messages - Messages to extract memory from
   * @param {Object} existingMemory - Existing memory to merge with
   * @returns {Object} Extracted memory block (new object, does not mutate input)
   */
  function extractMemoryRuleBased(messages, existingMemory) {
    // Create a copy to avoid mutating the original
    const memory = {
      entities: { ...(existingMemory?.entities || {}) },
      facts: [...(existingMemory?.facts || [])],
      currentGoal: existingMemory?.currentGoal || null
    };

    // Extract from messages using simple patterns
    const allText = messages
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join(' ');

    // Extract potential names (capitalized words)
    const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
    const names = [...new Set(allText.match(namePattern) || [])].slice(0, 10);

    if (names.length > 0) {
      memory.entities.mentionedNames = names;
    }

    // Extract URLs
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const urls = [...new Set(allText.match(urlPattern) || [])].slice(0, 5);

    if (urls.length > 0) {
      memory.entities.mentionedUrls = urls;
    }

    // Extract code-related terms
    const codePattern = /\b(function|class|const|let|var|import|export|require)\s+(\w+)/g;
    const codeTerms = [];
    let match;
    while ((match = codePattern.exec(allText)) !== null) {
      codeTerms.push(match[2]);
    }

    if (codeTerms.length > 0) {
      memory.entities.codeTerms = [...new Set(codeTerms)].slice(0, 20);
    }

    return memory;
  }

  /**
   * Format messages for extraction prompt
   * @param {Array} messages - Messages to format
   * @returns {string} Formatted messages text
   * @private
   */
  function _formatMessagesForExtraction(messages) {
    return messages.slice(-30).map(m => {
      const role = m.role.toUpperCase();
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${role}: ${content.substring(0, 500)}`;
    }).join('\n\n');
  }

  /**
   * Build the extraction prompt for the LLM (Prompt-as-Code v2)
   * Implements 5-class memory hierarchy with gates and conflict detection
   * Pre-truncates existing memory to prevent prompt overflow
   *
   * @param {Array} messages - Messages to extract from
   * @param {Object} existingMemory - Existing memory context
   * @returns {string} Extraction prompt
   */
  function buildExtractionPrompt(messages, existingMemory) {
    // Pre-truncate memory to fit within extraction budget
    const maxExtractionTokens = _getConfigValue('MAX_EXTRACTION_MEMORY_TOKENS');
    const truncatedMemory = truncateMemory(existingMemory, maxExtractionTokens);
    
    // Extract tool results BEFORE truncating messages
    const toolResults = extractToolResultsFromMessages(messages);
    
    // Build tool context section if we found valuable data
    let toolContext = '';
    if (toolResults.length > 0) {
      toolContext = `
  ### TOOL RESULTS (pre-extracted identifiers)
  \`\`\`json
  ${JSON.stringify(toolResults, null, 2)}
  \`\`\`

  **IMPORTANT**: The above tool results contain concrete identifiers that MUST be preserved in entities.anchors.
  `;
    }
    
    const messagesText = _formatMessagesForExtraction(messages);

    return `# MEMORY EXTRACTION PROTOCOL v2.0

  ## INPUT DATA

  ### CONVERSATION (last 30 messages)
  \`\`\`
  ${messagesText}
  \`\`\`
  ${toolContext}
  ### EXISTING MEMORY (from previous threads)
  \`\`\`json
  ${JSON.stringify(truncatedMemory || {}, null, 2)}
  \`\`\`

  ---

  ## EXTRACTION PROCEDURE

  Execute these steps IN ORDER. Each step has a GATE that must pass.

  ### STEP 1: EXTRACT ANCHORS (CLASS 0 - NEVER decay)

  **Definition**: System identifiers that enable interaction. Loss breaks the conversation.

  **Pattern matching**:
  - scriptId: /[a-zA-Z0-9_-]{40,50}/
  - spreadsheetId: /[a-zA-Z0-9_-]{40,50}/
  - projectId: /\\d{10,}/
  - API keys, URLs, file paths

  **Source priority**:
  1. TOOL RESULTS section (highest confidence)
  2. Explicit mentions in CONVERSATION
  3. EXISTING MEMORY (carry forward)

  **Output schema**:
  \`\`\`json
  {
    "anchors": {
      "scriptId": "exact_value_or_null",
      "spreadsheetId": "exact_value_or_null",
      "apiEndpoints": ["url1", "url2"],
      "filePaths": ["path1", "path2"]
    }
  }
  \`\`\`

  **GATE 1**: If TOOL RESULTS contains scriptId, output MUST include it verbatim.

  ---

  ### STEP 2: EXTRACT DECISIONS (CLASS 1 - SLOW decay)

  **Definition**: Technology/architecture choices that shape future work.

  **Extraction rules**:
  - FINAL STATE ONLY: "now using X" → include. "switched from Y to X" → include only X.
  - SUPERSEDE: If conversation changes a decision, the NEW decision wins.
  - MERGE: "Using PostgreSQL" + "DB on port 5432" → "PostgreSQL on port 5432"

  **Categories**: database, framework, architecture, hosting, auth, testing

  **Output schema**:
  \`\`\`json
  {
    "decisions": {
      "database": "PostgreSQL 15",
      "framework": "Express.js with TypeScript"
    }
  }
  \`\`\`

  **GATE 2**: Each decision must be SELF-CONTAINED. Maximum 10 decisions.

  ---

  ### STEP 3: EXTRACT CONTEXT (CLASS 2 - MEDIUM decay)

  **Definition**: Facts that improve response quality but aren't decisions.

  **Categories**: preferences, constraints, environment, knowledge

  **Extraction rules**:
  - Include if INFLUENCES FUTURE RESPONSES
  - Exclude if TRANSIENT (implementation details, debugging steps)
  - Exclude if DERIVABLE from code

  **Output schema**:
  \`\`\`json
  {
    "facts": [
      "User prefers functional programming style",
      "Project must support IE11"
    ]
  }
  \`\`\`

  **GATE 3**: Each fact must be ACTIONABLE. Maximum 15 facts.

  ---

  ### STEP 4: IDENTIFY CURRENT GOAL

  **Output schema**:
  \`\`\`json
  {
    "currentGoal": "Implementing user authentication with social login"
  }
  \`\`\`

  **GATE 4**: Goal must be SPECIFIC. If no clear goal, output null.

  ---

  ### STEP 5: CONFLICT DETECTION

  Before assembling output, check for these conflict patterns:

  **TECHNOLOGY CONFLICTS**:
  - If conversation mentions "switched to X", "migrated to X", "now using X"
    → Include ONLY X, not the previous technology

  **VERSION CONFLICTS**:
  - If multiple versions mentioned, use the LATEST

  **DECISION REVERSALS**:
  - If a decision was made then changed, use the FINAL decision

  **STALE FACT INDICATORS** (DO NOT include facts containing these):
  - "used to", "previously", "was", "switched from", "migrated from"
  - "tried X but", "reverted from", "rolled back", "changed from", "originally"

  ---

  ### STEP 6: ASSEMBLE OUTPUT

  **Cross-validation checks**:
  1. If scriptId in TOOL RESULTS → MUST appear in output entities.anchors
  2. If technology changed in conversation → old value MUST NOT appear
  3. If fact duplicates a decision → keep decision, remove fact
  4. All string values must be ≤200 chars

  **Final output schema**:
  \`\`\`json
  {
    "entities": {
      "anchors": { /* CLASS 0 - all preserved */ },
      "decisions": { /* CLASS 1 - merged, max 10 */ }
    },
    "facts": [ /* CLASS 2 - actionable only, max 15 */ ],
    "currentGoal": "string or null"
  }
  \`\`\`

  ---

  ## OUTPUT REQUIREMENTS

  Return ONLY the assembled JSON object.
  - No explanation text
  - No markdown formatting around the JSON
  - Valid JSON that parses without error

  If any GATE fails, re-execute that step until it passes.`;
  }

  /**
   * Merge new memory with existing memory
   *
   * @param {Object} existing - Existing memory block
   * @param {Object} extracted - Newly extracted memory
   * @returns {Object} Merged memory
   */
  function mergeMemory(existing, extracted) {
    const merged = {
      entities: { ...(existing?.entities || {}), ...(extracted?.entities || {}) },
      facts: [...(existing?.facts || []), ...(extracted?.facts || [])],
      currentGoal: extracted?.currentGoal || existing?.currentGoal || null
    };

    // Deduplicate facts
    merged.facts = [...new Set(merged.facts)].slice(-30);

    return merged;
  }

  // ============================================================================
  // SUMMARY GENERATION (Phase 2)
  // ============================================================================

  /**
   * Generate a summary of the conversation using LLM
   * LLM-only summary - no fallback per user requirement
   *
   * @param {Array} messages - Messages to summarize
   * @param {string} previousSummary - Previous summary to build upon
   * @returns {Object} Summary object with text and milestones
   */
  function generateSummary(messages, previousSummary) {
    // LLM-only summary - no fallback per user requirement
    return generateSummaryWithLLM(messages, previousSummary);
  }

  /**
   * Generate summary using Claude LLM API
   * Uses ClaudeApiUtils for robust retry logic and error handling
   *
   * @param {Array} messages - Messages to summarize
   * @param {string} previousSummary - Previous summary context
   * @returns {Object} Summary object
   */
  function generateSummaryWithLLM(messages, previousSummary) {
    const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');

    const summaryPrompt = buildSummaryPrompt(messages, previousSummary);

    log(`[ThreadContinuation] Calling LLM for summary (${messages.length} msgs, ${summaryPrompt.length} chars)`);

    // Use ClaudeApiUtils.complete for text response
    const result = ClaudeApiUtils.complete(summaryPrompt, {
      model: CONTINUATION_CONFIG.extractionModel,
      maxTokens: 1024,
      retryConfig: {
        maxRetries: 2,  // Fewer retries for summary (non-critical path)
        baseDelayMs: 1000,
        maxDelayMs: 10000
      }
    });

    if (!result.success) {
      throw new Error(result.error || 'Summary generation failed');
    }

    const content = result.text || '';

    log(`[ThreadContinuation] Summary complete: ${content.length} chars`);

    return {
      summary: content.substring(0, CONTINUATION_CONFIG.maxSummaryTokens * 4), // Rough char limit
      turnsCompacted: messages.length,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Fallback summary using recent messages
   *
   * @param {Array} messages - Messages to summarize
   * @param {string} previousSummary - Previous summary context
   * @returns {Object} Summary object
   */
  function generateSummaryFallback(messages, previousSummary) {
    // Take last 10 messages as "summary"
    const recentMessages = messages.slice(-10);
    const summaryText = recentMessages.map(m => {
      const role = m.role;
      const content = typeof m.content === 'string'
        ? m.content.substring(0, 200)
        : '[complex content]';
      return `${role}: ${content}`;
    }).join('\n');

    return {
      summary: (previousSummary ? previousSummary + '\n\n---\n\n' : '') +
               'Recent conversation:\n' + summaryText,
      turnsCompacted: messages.length,
      generatedAt: new Date().toISOString(),
      isFallback: true
    };
  }

  /**
   * Build the summary prompt for the LLM
   *
   * @param {Array} messages - Messages to summarize
   * @param {string} previousSummary - Previous summary context
   * @returns {string} Summary prompt
   */
  function buildSummaryPrompt(messages, previousSummary) {
    const messagesText = messages.map(m => {
      const role = m.role.toUpperCase();
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${role}: ${content.substring(0, 300)}`;
    }).join('\n\n');

    return `You are creating a conversation summary for context preservation.

  ${previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}\n\n` : ''}

  CONVERSATION TO SUMMARIZE:
  ${messagesText}

  TASK: Write a 2-3 paragraph summary focusing on:
  1. What topics were discussed
  2. What was decided or created
  3. Current state/goal at end of conversation

  Be concise but comprehensive. This summary will be used to continue the conversation in a new thread.`;
  }

  // ============================================================================
  // THREAD CHAIN MANAGEMENT (Phase 3)
  // ============================================================================

  /**
   * Create a new continuation thread
   *
   * @param {Object} parentThread - The thread being continued
   * @param {Object} memory - Extracted memory block
   * @param {Object} summaryData - Generated summary data
   * @param {Array} recentTurns - Recent messages to preserve
   * @returns {Object} New thread object
   */
  function createContinuationThread(parentThread, memory, summaryData, recentTurns) {
    const newThreadId = generateThreadId();
    const now = new Date().toISOString();

    // Extract historical anchors from the parent thread
    const AnchorExtractor = require('sheets-chat/AnchorExtractor');
    const anchorEntry = AnchorExtractor.createAnchorEntry(
      parentThread.id,
      parentThread.messages,
      summaryData.summary,
      memory.facts || []
    );

    // Carry forward historical anchors from parent + add new entry (limit 20)
    const existingAnchors = parentThread.historicalAnchors || [];
    const historicalAnchors = [...existingAnchors, anchorEntry].slice(-20);

    log(`[ThreadContinuation] Created anchor entry with ${anchorEntry.anchors.urls.length} URLs, ${anchorEntry.anchors.files.length} files`);

    const newThread = {
      id: newThreadId,
      title: parentThread.title ? `${parentThread.title} (continued)` : `Chat ${new Date().toLocaleString()}`,

      // Thread chain
      parentThread: parentThread.id,
      childThread: null,
      threadSequence: (parentThread.threadSequence || 1) + 1,

      // Inherited context
      memory: memory,
      inheritedSummary: summaryData.summary,

      // Historical anchors from all past threads
      historicalAnchors: historicalAnchors,

      // Fresh message history with context
      messages: recentTurns,

      // Metadata
      createdAt: now,
      continuedFrom: parentThread.createdAt || parentThread.startedAt,
      user: parentThread.user
    };

    log(`[ThreadContinuation] Created continuation thread: ${newThreadId} (sequence ${newThread.threadSequence}), ${historicalAnchors.length} historical anchors`);

    return newThread;
  }

  /**
   * Check if memory should be re-distilled
   *
   * @param {number} threadSequence - Current thread sequence number
   * @returns {boolean} True if re-distillation is needed
   */
  function needsRedistillation(threadSequence) {
    return threadSequence > 0 &&
           threadSequence % CONTINUATION_CONFIG.redistillationInterval === 0;
  }

  /**
   * Build redistillation prompt (Prompt-as-Code v2)
   * Implements 5-class decay rules with budget enforcement
   * 
   * @param {Object} memory - Memory to redistill
   * @returns {string} Redistillation prompt
   * @private
   */
  function _buildRedistillationPrompt(memory) {
    const config = getMemoryGenerationConfig();
    const tokens = estimateMemoryTokens(memory);
    
    return `# MEMORY REDISTILLATION PROTOCOL v2.0

  ## CURRENT MEMORY (${tokens} tokens, budget: ${config.totalBudget})

  \`\`\`json
  ${JSON.stringify(memory, null, 2)}
  \`\`\`

  ---

  ## REDISTILLATION PROCEDURE

  Goal: Condense memory to fit budget while preserving critical information.

  ### PHASE 1: CLASSIFY EXISTING ITEMS

  For each item in memory, assign a class:

  | Class | Decay | Examples | Action |
  |-------|-------|----------|--------|
  | 0-ANCHOR | NEVER | scriptId, spreadsheetId | KEEP ALL |
  | 1-DECISION | SLOW | "Using PostgreSQL" | KEEP, MERGE if related |
  | 2-CONTEXT | MEDIUM | "User prefers tabs" | KEEP if actionable, else DROP |
  | 3-EPISODE | FAST | "Implemented auth" | COMPRESS to 1-line outcome |
  | 4-ARCHIVE | AGGRESSIVE | old gist | TRUNCATE to 200 chars |

  ### PHASE 2: APPLY DECAY RULES

  **ANCHORS (Class 0)**:
  - Rule: NEVER delete or modify
  - Action: Copy verbatim to output

  **DECISIONS (Class 1)**:
  - Rule: Merge related decisions
  - Example: "PostgreSQL" + "port 5432" → "PostgreSQL on port 5432"
  - Action: Keep max 10, prefer specific over vague

  **CONTEXT (Class 2)**:
  - Rule: Drop if no longer actionable
  - Test: "Does this change how I would respond?" If no → DROP
  - Action: Keep max 15, merge overlapping facts

  **EPISODES (Class 3)**:
  - Rule: Compress to outcome only
  - Transform: "Implemented auth with JWT, added refresh tokens, fixed security bug" → "Built JWT auth system"
  - Action: Keep max 3 episodes, each ≤50 chars

  **ARCHIVE (Class 4)**:
  - Rule: Extreme compression
  - Transform: Full paragraph → "Building CRM app. Completed: auth, API. Current: UI."
  - Action: Max 200 chars total

  ### PHASE 3: BUDGET ENFORCEMENT

  If still over budget (${config.totalBudget} tokens), apply in order:
  1. Truncate archive.gist to 100 chars
  2. Reduce episodes to 2
  3. Reduce facts to 10
  4. Reduce decisions to 7
  5. NEVER reduce anchors

  ### PHASE 4: OUTPUT

  **Output schema**:
  \`\`\`json
  {
    "entities": {
      "anchors": { /* Class 0 - all preserved */ },
      "decisions": { /* Class 1 - merged, max 10 */ }
    },
    "facts": [ /* Class 2 - actionable only, max 15 */ ],
    "currentGoal": "string or null",
    "recent": {
      "episodes": [ /* Class 3 - compressed outcomes, max 3 */ ]
    },
    "archive": {
      "gist": "string max 200 chars",
      "importantFacts": [ /* promoted Class 2 facts, max 5 */ ]
    }
  }
  \`\`\`

  ---

  ## VALIDATION GATES

  **GATE A**: All anchors from input MUST appear in output (no anchor loss)
  **GATE B**: Total estimated tokens ≤ ${config.totalBudget}
  **GATE C**: No fact >200 chars
  **GATE D**: Archive gist ≤200 chars

  If any gate fails, re-apply Phase 2 with more aggressive decay.

  ---

  Return ONLY valid JSON. No explanation.`;
  }

  /**
   * Re-distill accumulated memory to prevent bloat
   * Uses ClaudeApiUtils for robust retry logic and error handling
   * Pre-truncates memory to prevent prompt overflow
   * Implements Prompt-as-Code v2 with 5-class decay hierarchy
   *
   * @param {Object} memory - Accumulated memory to distill
   * @returns {Object} Distilled memory
   */
  function redistillMemory(memory) {
    try {
      const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');
      
      // Pre-truncate memory to fit within extraction budget
      const maxExtractionTokens = _getConfigValue('MAX_EXTRACTION_MEMORY_TOKENS');
      const truncatedMemory = truncateMemory(memory, maxExtractionTokens);

      const prompt = _buildRedistillationPrompt(truncatedMemory);

      // Count facts across structures for logging
      const factCount = (truncatedMemory.facts || []).length + 
                        (truncatedMemory.current?.facts || []).length;
      log(`[ThreadContinuation] Calling LLM for redistillation (${factCount} facts to condense)`);

      // Use ClaudeApiUtils.completeJSON for JSON response handling
      const result = ClaudeApiUtils.completeJSON(prompt, {
        model: CONTINUATION_CONFIG.extractionModel,
        maxTokens: 1500,  // Increased for more complex output structure
        retryConfig: {
          maxRetries: 2,
          baseDelayMs: 1000,
          maxDelayMs: 10000
        }
      });

      if (!result.success) {
        throw new Error(result.error || 'Redistillation failed');
      }

      const distilled = result.json || memory;
      
      // Count distilled facts
      const distilledFactCount = (distilled.facts || []).length + 
                                 (distilled.current?.facts || []).length;

      log(`[ThreadContinuation] Redistillation complete: ${distilledFactCount} facts remaining`);

      return distilled;
    } catch (error) {
      log(`[ThreadContinuation] Redistillation failed, keeping current memory: ${error.message}`);
      return memory;
    }
  }

  // ============================================================================
  // MAIN CONTINUATION HANDLER
  // ============================================================================

  /**
   * Handle thread continuation
   * This is the main entry point called when continuation is triggered
   *
   * @param {Object} conversation - Current conversation object
   * @param {string} pendingUserMessage - User message that triggered continuation
   * @returns {Object} Result with new thread info
   */
  function handleThreadContinuation(conversation, pendingUserMessage) {
    const startTime = Date.now();
    log('[ThreadContinuation] Starting thread continuation...');

    try {
      // 1. Archive current thread
      if (CONTINUATION_CONFIG.archiveToJournal) {
        try {
          const DriveJournal = require('sheets-chat/DriveJournal');
          DriveJournal.appendToJournal(conversation.id, conversation.messages);
          log('[ThreadContinuation] Archived to Drive Journal');
        } catch (archiveError) {
          log(`[ThreadContinuation] Archive failed (non-blocking): ${archiveError.message}`);
        }
      }

      // 2. Extract memory
      const memory = extractMemory(conversation.messages, conversation.memory);
      log(`[ThreadContinuation] Memory extracted: ${Object.keys(memory.entities || {}).length} entities, ${(memory.facts || []).length} facts`);

      // 3. Generate summary
      const summaryData = generateSummary(
        conversation.messages,
        conversation.inheritedSummary
      );
      log(`[ThreadContinuation] Summary generated: ${summaryData.summary.length} chars`);

      // 4. Get recent turns to preserve verbatim
      const recentTurns = getRecentTurns(
        conversation.messages,
        CONTINUATION_CONFIG.keepRecentTurns
      );
      log(`[ThreadContinuation] Preserved ${recentTurns.length} recent messages`);

      // 5. Check for re-distillation
      let finalMemory = memory;
      if (needsRedistillation((conversation.threadSequence || 1) + 1)) {
        log('[ThreadContinuation] Re-distilling memory...');
        finalMemory = redistillMemory(memory);
      }

      // 6. Create new thread
      const newThread = createContinuationThread(
        conversation,
        finalMemory,
        summaryData,
        recentTurns
      );

      // 7. Link threads (update parent to point to child)
      conversation.childThread = newThread.id;

      const elapsed = Date.now() - startTime;
      log(`[ThreadContinuation] Continuation complete in ${elapsed}ms`);

      return {
        success: true,
        newThread: newThread,
        parentThreadId: conversation.id,
        elapsed: elapsed,
        threadContinued: true
      };

    } catch (error) {
      const elapsed = Date.now() - startTime;
      log(`[ThreadContinuation] Continuation failed (${elapsed}ms): ${error.message}`);

      return {
        success: false,
        error: error.message,
        elapsed: elapsed
      };
    }
  }

  // ============================================================================
  // EXPORTS
  // ============================================================================

  module.exports = {
    // Configuration
    CONTINUATION_CONFIG,

    // Phase 1: Token estimation and detection
    estimateTokens,
    estimateMessageTokens,
    shouldContinue,
    isContextExceededError,
    getRecentTurns,
    generateThreadId,

    // Generational memory functions
    getMemoryGenerationConfig,
    estimateMemoryTokens,
    truncateMemory,
    compressToEpisode,
    mergeIntoArchive,
    demoteGenerations,
    enforceMemoryBudget,

    // Tool result extraction
    containsProjectIdentifiers,
    looksLikeConfig,
    containsApiData,
    extractIdentifiers,
    extractConfigValues,
    extractApiData,
    extractToolResultValues,
    extractToolResultsFromMessages,

    // Contradiction detection & validation
    validateMemoryContradictions,
    repairMemoryContradictions,
    deduplicateFacts,

    // Phase 2: Memory and summary
    extractMemory,
    extractMemoryWithLLM,
    extractMemoryRuleBased,
    generateSummary,
    generateSummaryWithLLM,
    generateSummaryFallback,
    mergeMemory,

    // Phase 3: Thread chain management
    createContinuationThread,
    needsRedistillation,
    redistillMemory,

    // Main handler
    handleThreadContinuation
  };
}

__defineModule__(_main);