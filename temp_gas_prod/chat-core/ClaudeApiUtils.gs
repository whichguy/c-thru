function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ClaudeApiUtils.js - Shared Claude API Utility for Sheets Chat
   *
   * This module provides a centralized interface for making Claude API calls,
   * leveraging UrlFetchUtils for robust retry logic, exponential backoff,
   * and proper error handling.
   *
   * Used by:
   * - ThreadContinuation.js (memory extraction, summary generation, redistillation)
   * - Future modules needing direct Claude API access
   *
   * @module chat-core/ClaudeApiUtils
   */

    // Dependencies
    const UrlFetchUtils = require('common-js/UrlFetchUtils');
    const ConfigManager = require('common-js/ConfigManager');

    /**
     * Claude API configuration
     * @type {Object}
     */
    const API_CONFIG = {
      baseUrl: require('chat-core/ChatConstants').getConfig('CLAUDE_API_BASE_URL') + '/v1/messages',
      anthropicVersion: '2023-06-01',
      defaultModel: 'claude-sonnet-4-6',
      defaultMaxTokens: 1024,

      // Retry configuration for Claude API
      retry: {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        jitterPercent: 20,
        // 429 (rate limit), 529 (overloaded), 500, 502, 503, 504 (server errors)
        retryableStatuses: [429, 500, 502, 503, 504, 529],
        // Don't retry client errors (except rate limits)
        nonRetryableStatuses: [400, 401, 403, 404, 405]
      }
    };

    /**
     * Error types from Claude API
     * @enum {string}
     */
    const ClaudeErrorTypes = {
      INVALID_REQUEST: 'invalid_request_error',
      AUTHENTICATION: 'authentication_error',
      PERMISSION: 'permission_error',
      NOT_FOUND: 'not_found_error',
      RATE_LIMIT: 'rate_limit_error',
      API_ERROR: 'api_error',
      OVERLOADED: 'overloaded_error'
    };

    /**
     * Call Claude API with retry logic and proper error handling
     *
     * Note: GAS UrlFetchApp has a fixed timeout (~30s for individual requests,
     * 6-minute total execution limit). This function does not support custom
     * timeouts but uses UrlFetchUtils retry logic to handle transient failures.
     *
     * @param {Object} options - API call options
     * @param {string} options.model - Model to use (default: claude-haiku-4-5-20251001)
     * @param {Array} options.messages - Array of message objects
     * @param {number} options.maxTokens - Maximum tokens to generate (default: 1024)
     * @param {string} options.system - Optional system prompt
     * @param {number} options.temperature - Optional temperature (0-1)
     * @param {Array} options.tools - Optional tools array
     * @param {Object} options.thinking - Optional thinking configuration
     * @param {boolean} options.thinking.enabled - Enable extended thinking
     * @param {number} options.thinking.budgetTokens - Thinking budget (min 1024, must be < maxTokens)
     * @param {string} options.apiKey - Optional API key override (uses config if not provided)
     * @param {Object} options.retryConfig - Optional retry configuration override
     * @param {number} options.retryConfig.maxRetries - Maximum retry attempts
     * @param {number} options.retryConfig.baseDelayMs - Base delay between retries
     * @param {number} options.retryConfig.maxDelayMs - Maximum delay between retries
     * @returns {Object} Result object {success, data?, error?, retryStats?, elapsed?}
     */
    function callClaudeAPI(options = {}) {
      const startTime = Date.now();

      // Validate required parameters
      if (!options.messages || !Array.isArray(options.messages) || options.messages.length === 0) {
        return {
          success: false,
          error: 'Messages array is required and must not be empty'
        };
      }

      // Get API key
      let apiKey = options.apiKey;
      if (!apiKey) {
        try {
          const config = new ConfigManager('CLAUDE_CHAT');
          apiKey = config.get('API_KEY');
        } catch (e) {
          log(`[ClaudeApiUtils] Failed to get API key from config: ${e.message}`);
        }
      }

      if (!apiKey) {
        return {
          success: false,
          error: 'No API key available. Set ANTHROPIC_API_KEY in config or pass apiKey option.'
        };
      }

      // Build request payload
      const payload = {
        model: options.model || API_CONFIG.defaultModel,
        max_tokens: options.maxTokens || API_CONFIG.defaultMaxTokens,
        messages: options.messages
      };

      // Optional parameters
      if (options.system) {
        payload.system = options.system;
      }
      if (typeof options.temperature === 'number') {
        payload.temperature = options.temperature;
      }
      if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
        payload.tools = options.tools;
      }

      // Extended thinking support
      if (options.thinking?.enabled) {
        const { getConfig } = require('chat-core/ChatConstants');
        const requestedBudget = options.thinking.budgetTokens || getConfig('THINKING_BUDGET_TOKENS');
        const maxTokens = options.maxTokens || API_CONFIG.defaultMaxTokens;
        // API requires: 1024 <= budget_tokens < max_tokens (match ClaudeConversation logic)
        const effectiveBudget = Math.min(requestedBudget, maxTokens - 1);
        if (effectiveBudget >= 1024) {
          payload.thinking = {
            type: 'enabled',
            budget_tokens: effectiveBudget
          };
          // Note: temperature must be default when thinking is enabled
          delete payload.temperature;
          log(`[ClaudeApiUtils] Thinking enabled with budget ${effectiveBudget} tokens`);
        } else {
          log(`[ClaudeApiUtils] Thinking budget invalid (${effectiveBudget}), must be >= 1024`);
        }
      }

      // Build fetch options
      const fetchOptions = {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_CONFIG.anthropicVersion
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      // Merge retry config
      const retryConfig = {
        ...API_CONFIG.retry,
        ...(options.retryConfig || {}),
        think: (msg) => log(`[ClaudeApiUtils] ${msg}`)
      };

      try {
        log(`[ClaudeApiUtils] Calling ${payload.model} with ${options.messages.length} messages`);

        // Use UrlFetchUtils for robust retry handling
        const { response, retryStats } = UrlFetchUtils.fetchWithRetry(
          API_CONFIG.baseUrl,
          fetchOptions,
          retryConfig
        );

        const responseText = response.getContentText();
        const elapsed = Date.now() - startTime;

        // Parse response
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (parseError) {
          log(`[ClaudeApiUtils] Failed to parse response: ${parseError.message}`);
          return {
            success: false,
            error: `Failed to parse API response: ${parseError.message}`,
            rawResponse: responseText.substring(0, 500),
            retryStats,
            elapsed
          };
        }

        // Check for API-level errors in response body
        if (result.error) {
          const errorInfo = parseClaudeError(result.error);
          log(`[ClaudeApiUtils] API error: ${errorInfo.type} - ${errorInfo.message}`);
          return {
            success: false,
            error: errorInfo.message,
            errorType: errorInfo.type,
            retryStats,
            elapsed
          };
        }

        // Success!
        log(`[ClaudeApiUtils] Success in ${elapsed}ms (${retryStats.attempts} attempt(s))`);

        return {
          success: true,
          data: result,
          retryStats,
          elapsed
        };

      } catch (error) {
        const elapsed = Date.now() - startTime;
        log(`[ClaudeApiUtils] Request failed after ${elapsed}ms: ${error.message}`);

        // Parse error for more context
        const errorInfo = parseErrorMessage(error.message);

        return {
          success: false,
          error: error.message,
          errorType: errorInfo.type,
          isRetryable: errorInfo.isRetryable,
          elapsed
        };
      }
    }

    /**
     * Simple text completion helper
     * Wraps callClaudeAPI for simple prompt -> response use cases
     *
     * @param {string} prompt - User prompt text
     * @param {Object} options - Optional configuration
     * @param {string} options.model - Model to use
     * @param {number} options.maxTokens - Max tokens
     * @param {string} options.system - System prompt
     * @returns {Object} Result with {success, text?, error?}
     */
    function complete(prompt, options = {}) {
      if (!prompt || typeof prompt !== 'string') {
        return {
          success: false,
          error: 'Prompt must be a non-empty string'
        };
      }

      const result = callClaudeAPI({
        ...options,
        messages: [{ role: 'user', content: prompt }]
      });

      if (!result.success) {
        return result;
      }

      // Extract text from response
      const text = extractTextFromResponse(result.data);

      return {
        success: true,
        text,
        usage: result.data.usage,
        model: result.data.model,
        elapsed: result.elapsed
      };
    }

    /**
     * JSON completion helper
     * Calls Claude and attempts to parse response as JSON
     *
     * @param {string} prompt - Prompt that should elicit JSON response
     * @param {Object} options - Optional configuration
     * @returns {Object} Result with {success, json?, text?, error?}
     */
    function completeJSON(prompt, options = {}) {
      const result = complete(prompt, options);

      if (!result.success) {
        return result;
      }

      // Attempt JSON parsing
      try {
        // Try to extract JSON from response (may be wrapped in markdown)
        const jsonText = extractJSONFromText(result.text);
        const json = JSON.parse(jsonText);

        return {
          success: true,
          json,
          text: result.text,
          usage: result.usage,
          model: result.model,
          elapsed: result.elapsed
        };
      } catch (parseError) {
        return {
          success: false,
          error: `Failed to parse JSON from response: ${parseError.message}`,
          text: result.text,
          usage: result.usage,
          model: result.model,
          elapsed: result.elapsed
        };
      }
    }

    /**
     * Extract text content from Claude API response
     *
     * @param {Object} response - Claude API response
     * @returns {string} Extracted text content
     */
    function extractTextFromResponse(response) {
      if (!response || !response.content) {
        return '';
      }

      if (Array.isArray(response.content)) {
        return response.content
          .filter(block => block.type === 'text' && block.text)
          .map(block => block.text)
          .join('\n');
      }

      return '';
    }

    /**
     * Extract thinking content from Claude API response
     * Preserves signatures for potential verification/caching
     *
     * @param {Object} response - Claude API response
     * @returns {Array} Array of thinking objects {thinking, signature}
     */
    function extractThinkingFromResponse(response) {
      if (!response || !response.content || !Array.isArray(response.content)) {
        return [];
      }

      return response.content
        .filter(block => block.type === 'thinking')
        .map(block => ({
          thinking: block.thinking,
          signature: block.signature || null
        }));
    }

    /**
     * Extract JSON from text that may contain markdown code blocks
     *
     * @param {string} text - Text that may contain JSON
     * @returns {string} Cleaned JSON string
     */
    function extractJSONFromText(text) {
      if (!text) return '{}';

      // Try to find JSON in code block first (highest priority)
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
      }

      // Try to find a balanced JSON object starting from the first {
      // This handles cases like "Result: {valid JSON}"
      const firstBrace = text.indexOf('{');
      const firstBracket = text.indexOf('[');

      let startChar = null;
      let endChar = null;
      let startIdx = -1;

      if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startChar = '{';
        endChar = '}';
        startIdx = firstBrace;
      } else if (firstBracket !== -1) {
        startChar = '[';
        endChar = ']';
        startIdx = firstBracket;
      }

      if (startIdx !== -1) {
        // Find matching closing brace/bracket by counting depth
        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let i = startIdx; i < text.length; i++) {
          const char = text[i];

          if (escapeNext) {
            escapeNext = false;
            continue;
          }

          if (char === '\\' && inString) {
            escapeNext = true;
            continue;
          }

          if (char === '"') {
            inString = !inString;
            continue;
          }

          if (!inString) {
            if (char === startChar) {
              depth++;
            } else if (char === endChar) {
              depth--;
              if (depth === 0) {
                return text.substring(startIdx, i + 1).trim();
              }
            }
          }
        }
      }

      // Return as-is if no JSON found
      return text.trim();
    }

    /**
     * Parse Claude API error object
     *
     * @param {Object} error - Error object from API response
     * @returns {Object} Parsed error info {type, message}
     */
    function parseClaudeError(error) {
      if (!error) {
        return { type: 'unknown', message: 'Unknown error' };
      }

      return {
        type: error.type || 'unknown',
        message: error.message || JSON.stringify(error)
      };
    }

    /**
     * Parse error message to determine type and retryability
     *
     * @param {string} message - Error message
     * @returns {Object} {type, isRetryable}
     */
    function parseErrorMessage(message) {
      const lowerMessage = (message || '').toLowerCase();

      // Rate limit errors
      if (lowerMessage.includes('rate') || lowerMessage.includes('429')) {
        return { type: ClaudeErrorTypes.RATE_LIMIT, isRetryable: true };
      }

      // Overloaded errors
      if (lowerMessage.includes('overloaded') || lowerMessage.includes('529')) {
        return { type: ClaudeErrorTypes.OVERLOADED, isRetryable: true };
      }

      // Server errors
      if (lowerMessage.includes('500') || lowerMessage.includes('502') ||
          lowerMessage.includes('503') || lowerMessage.includes('504')) {
        return { type: ClaudeErrorTypes.API_ERROR, isRetryable: true };
      }

      // Authentication errors
      if (lowerMessage.includes('401') || lowerMessage.includes('authentication') ||
          lowerMessage.includes('unauthorized')) {
        return { type: ClaudeErrorTypes.AUTHENTICATION, isRetryable: false };
      }

      // Permission errors
      if (lowerMessage.includes('403') || lowerMessage.includes('forbidden') ||
          lowerMessage.includes('permission')) {
        return { type: ClaudeErrorTypes.PERMISSION, isRetryable: false };
      }

      // Invalid request errors
      if (lowerMessage.includes('400') || lowerMessage.includes('invalid') ||
          lowerMessage.includes('bad request')) {
        return { type: ClaudeErrorTypes.INVALID_REQUEST, isRetryable: false };
      }

      // Context length errors (important for ThreadContinuation)
      if (lowerMessage.includes('context') || lowerMessage.includes('token') ||
          lowerMessage.includes('prompt is too long')) {
        return { type: ClaudeErrorTypes.INVALID_REQUEST, isRetryable: false };
      }

      return { type: 'unknown', isRetryable: false };
    }

    /**
     * Check if an error indicates context window was exceeded
     * Delegates to more specific error detection
     *
     * @param {Error|Object|string} error - Error to check
     * @returns {boolean} True if context exceeded
     */
    function isContextExceededError(error) {
      const message = error?.message || error?.error?.message || String(error);
      const lowerMessage = message.toLowerCase();

      const patterns = [
        'context_length_exceeded',
        'prompt is too long',
        'max_tokens',
        'context window',
        'token limit',
        'exceeds the maximum'
      ];

      return patterns.some(pattern => lowerMessage.includes(pattern));
    }

    // ============================================================================
    // CONTENT BLOCK UTILITIES
    // ============================================================================

    /**
     * Extract text from message content (handles both string and content block array).
     * Unlike extractTextFromResponse (which operates on API response objects),
     * this operates on message.content values from conversation histories/journals.
     *
     * @param {string|Array} content - String content or array of content blocks
     * @returns {string} Extracted text
     */
    function extractTextFromContent(content) {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.filter(function(b) { return b && b.type === 'text' && b.text; })
          .map(function(b) { return b.text; }).join(' ');
      }
      return '';
    }

    /**
     * Check if a message is a tool_result (role:'user' but content is tool execution results).
     * In Claude API, tool results are sent as user messages with content blocks of type 'tool_result'.
     *
     * @param {Object} msg - Message object with role and content
     * @returns {boolean}
     */
    function isToolResultMessage(msg) {
      return msg && Array.isArray(msg.content) && msg.content.length > 0 && msg.content[0].type === 'tool_result';
    }

    /**
     * Check if an assistant message has ONLY tool_use blocks (no human-readable text).
     *
     * @param {Object} msg - Message object with role and content
     * @returns {boolean}
     */
    function isToolUseOnlyMessage(msg) {
      return msg && msg.role === 'assistant' && Array.isArray(msg.content) &&
        !msg.content.some(function(b) { return b.type === 'text' && b.text && b.text.trim(); });
    }

    // ============================================================================
    // EXPORTS
    // ============================================================================

    module.exports = {
      // Configuration
      API_CONFIG,
      ClaudeErrorTypes,

      // Main API function
      callClaudeAPI,

      // Helper functions
      complete,
      completeJSON,

      // Content block utilities
      extractTextFromContent,
      isToolResultMessage,
      isToolUseOnlyMessage,

      // Utility functions
      extractTextFromResponse,
      extractThinkingFromResponse,
      extractJSONFromText,
      parseClaudeError,
      parseErrorMessage,
      isContextExceededError
    };
}

__defineModule__(_main);