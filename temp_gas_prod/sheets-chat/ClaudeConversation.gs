function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
     * ClaudeConversation - Standalone class for Claude API conversations
     * Supports multimodal inputs (text, attachments), extended thinking, and tool calls
     * Stateless - all conversation state managed by caller
     * Auto-instantiates tools, handles thinking queue, and manages sequence IDs
     * 
     * SIMPLE USAGE:
     * const claude = new ClaudeConversation();
     * const result = claude.sendMessage({ messages: [], text: 'Hello Claude!' });
     */

    class ClaudeConversation {
      /**
       * Create a ClaudeConversation instance
       * @param {string} apiKey - Anthropic API key (optional, reads from config if not provided)
       * @param {string|Object} model - Model name OR options object for backward compatibility
       * @param {Object} options - Configuration options
       * @param {Array} options.tools - Inline tool definitions with execute functions
       *   Each tool: { name, description, input_schema, execute: (input, context) => result }
       * @param {string} options.system - Default system prompt override (used when sendMessage doesn't provide one)
       */
      constructor(apiKey, model = null, options = {}) {
        // Handle backward compatibility - if model is an object, treat as options
        if (model && typeof model === 'object' && !Array.isArray(model)) {
          options = model;
          model = null;
        }
        
        // Auto-require Code module for infrastructure
        const UISupport = require('sheets-chat/UISupport');
        this._UISupport = UISupport;
        
        // Use provided API key or get from Code
        this.apiKey = apiKey || UISupport.getApiKey();
        
        this.apiUrl = 'https://api.anthropic.com/v1/messages';
        
        // Read model from constructor param, ConfigManager, or use default
        if (model) {
          this.model = model;
        } else {
          const ConfigManager = require('gas-properties/ConfigManager');
          const config = new ConfigManager('CLAUDE_CHAT');
          this.model = config.get('MODEL_NAME') || 'claude-sonnet-4-5';
        }
        
        // Use centralized constant for thinking budget
        const { getConfig } = require('sheets-chat/ChatConstants');
        this.thinkingBudget = getConfig('THINKING_BUDGET_TOKENS');
        
        // Auto-instantiate ToolRegistry with all tools enabled
        const ToolRegistry = require('tools/ToolRegistry');
        this._toolRegistry = new ToolRegistry({
          enableExec: true,
          enableSearch: true,
          enableKnowledge: true,
          enablePrompt: true,
          enableAnalyzeUrl: true
        });
        
        // Pre-load SystemPrompt module to avoid timing issues
        const SystemPrompt = require('sheets-chat/SystemPrompt');
        this._SystemPrompt = SystemPrompt;
        
        // Store inline tools (with execute functions) from constructor
        this._inlineTools = options.tools || [];
        
        // Build a map for quick lookup during execution
        this._inlineToolHandlers = new Map();
        this._inlineTools.forEach(tool => {
          if (tool.name && tool.execute) {
            this._inlineToolHandlers.set(tool.name, tool);
          }
        });
        
        // Register internal knowledge management tools
        // These allow Claude to manage the Knowledge sheet programmatically
        const knowledgeTools = this._getKnowledgeManagementTools();
        knowledgeTools.forEach(tool => {
          this._inlineTools.push(tool);
          this._inlineToolHandlers.set(tool.name, tool);
        });
        
        // Store default system prompt override from constructor
        this._defaultSystemPrompt = options.system || null;
      }

      /**
       * Safely stringify and truncate object for logging
       * @private
       * @param {*} obj - Object to stringify
       * @param {number} maxLength - Maximum string length (default 500)
       * @returns {string} JSON string, truncated if needed
       */
      _truncateJson(obj, maxLength = 500) {
        try {
          const json = JSON.stringify(obj);
          if (json.length <= maxLength) return json;
          return json.substring(0, maxLength) + '...';
        } catch (e) {
          return '[stringify error]';
        }
      }

      /**
       * Merge tools from multiple sources with correct precedence
       * Higher priority sources override lower by tool name
       *
       * Precedence (highest to lowest):
       * 1. Per-message tools (messageTools)
       * 2. Constructor tools (this._inlineTools)
       * 3. Registry tools (from sheet + drive)
       *
       * @private
       * @param {Array} registryTools - Tools from ToolRegistry (sheet + drive)
       * @param {Array} messageTools - Tools passed to sendMessage() (optional)
       * @returns {Array} Merged tool definitions for Claude API
       */
      _mergeTools(registryTools, messageTools = null) {
        const toolMap = new Map();

        // 1. Registry tools (lowest priority) - includes sheet + DriveApp
        registryTools.forEach(tool => toolMap.set(tool.name, tool));

        // 2. Constructor inline tools (override registry)
        if (this._inlineTools && this._inlineTools.length > 0) {
          this._inlineTools.forEach(tool => {
            toolMap.set(tool.name, {
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema
            });
            // Ensure execute function is in handlers map
            if (tool.execute) {
              this._inlineToolHandlers.set(tool.name, tool);
            }
          });
        }

        // 3. Per-message tools (highest priority, override everything)
        if (messageTools && messageTools.length > 0) {
          messageTools.forEach(tool => {
            toolMap.set(tool.name, {
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema
            });
            // Store handler for execution
            if (tool.execute) {
              this._inlineToolHandlers.set(tool.name, tool);
            }
          });
        }

        return Array.from(toolMap.values());
      }

      /**
       * Format tool result content for Claude API
       * Returns array with document block for PDFs/images, JSON string otherwise
       * @private
       */
      _formatToolResultContent(toolResult) {
        if (toolResult.success === true && toolResult.result !== undefined) {
          const result = toolResult.result;

          // Check if this is a PDF response from fetch/fetchUrls
          if (result.isBinary && result.mimeType === 'application/pdf' && result.base64) {
            return [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  url: result.url,
                  mimeType: result.mimeType,
                  size: result.size
                })
              },
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: result.base64
                }
              }
            ];
          }

          // Check for images
          if (result.isBinary && result.mimeType && result.mimeType.startsWith('image/') && result.base64) {
            return [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  url: result.url,
                  mimeType: result.mimeType,
                  size: result.size
                })
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: result.mimeType,
                  data: result.base64
                }
              }
            ];
          }

          // Normal JSON response
          return JSON.stringify(result);
        } else if (toolResult.success === false) {
          return JSON.stringify({
            error: toolResult.error,
            message: toolResult.message,
            name: toolResult.name
          });
        }
        return JSON.stringify(toolResult);
      }

      /**
       * Send a message to Claude API
       * SIMPLIFIED - No need to pass onThinking, sequenceId, or manage infrastructure
       * 
       * @param {Object} params - Message parameters
       * @param {Array} params.messages - Conversation history (pass empty [] for new conversation, or result.threadHistorySnippet from previous turn)
       * @param {string} params.text - Text prompt to send
       * @param {string} params.system - System prompt for Claude (optional)
       * @param {Object} params.context - Execution context (depth, maxDepth, toolsEnabled, toolState)
       * @param {Array} params.attachments - Array of attachments:
       *   - Image/PDF: {data: base64String, mediaType: 'image/png|jpeg|gif|webp|application/pdf'}
       *   - URL fetch: {type: 'fetchUrl', url: 'https://...'}
       * @param {number} params.maxTokens - Max response tokens (default 4096)
       * @param {boolean} params.enableThinking - Enable extended thinking (default true)
       * @returns {Object} Result object containing:
       *   - response: String - Text response from Claude
       *   - message: Object - Assistant message object {role, content}
       *   - messages: Array - Full conversation history (backward compatibility)
       *   - threadHistorySnippet: Array - Delta from this turn only (use for next turn)
       *   - usage: Object - Token usage statistics
       *   - thinkingMessages: Array - Extended thinking content
       *   - toolUses: Array - Tool calls made (if any)
       *   - sequenceId: String - Message sequence ID
       *   - context: Object - Updated execution context
       * 
       * @example
       * // Single-turn conversation
       * const result = conversation.sendMessage({
       *   messages: [],
       *   text: 'What is 2+2?'
       * });
       * 
       * @example
       * // Multi-turn conversation using threadHistorySnippet
       * const turn1 = conversation.sendMessage({
       *   messages: [],
       *   text: 'Remember the number 42'
       * });
       * 
       * const turn2 = conversation.sendMessage({
       *   messages: turn1.threadHistorySnippet,  // Pass snippet from previous turn
       *   text: 'What number did I ask you to remember?'
       * });
       * // Claude responds: "You asked me to remember 42"
       * 
       * @example
       * // With image attachment
       * const result = conversation.sendMessage({
       *   messages: [],
       *   text: 'What color is this?',
       *   attachments: [{
       *     data: imageBase64,
       *     mediaType: 'image/png'
       *   }]
       * });
       * 
       * @example
       * // With URL fetch (server-side)
       * const result = conversation.sendMessage({
       *   messages: [],
       *   text: 'Summarize this page',
       *   attachments: [{
       *     type: 'fetchUrl',
       *     url: 'https://example.com'
       *   }]
       * });
       */
      sendMessage(params) {
        const {
          messages = [],
          text,
          system = null,
          context = {},
          attachments = [],
          maxTokens = null,  // Will use ChatConstants.MAX_RESPONSE_TOKENS if not provided
          enableThinking = true,
          requestId,
          sequenceId,
          model = null,  // Optional per-message model override
          tools: messageTools = null  // Per-message inline tools (highest precedence)
        } = params;
        
        // Use provided model or fall back to constructor's model
        const modelToUse = model || this.model;
        
        // Resolve maxTokens from ChatConstants if not provided
        const { getConfig } = require('sheets-chat/ChatConstants');
        const resolvedMaxTokens = maxTokens || getConfig('MAX_RESPONSE_TOKENS');

        // Channel clearing is now handled per-request in sendMessageToClaude()
        // Each request has its own channel (thinking-${requestId})

        // Extract depth from context
        const depth = context.depth || 0;

        // System prompt precedence:
        // 1. Per-message system (passed to sendMessage)
        // 2. Constructor system (this._defaultSystemPrompt)
        // 3. Auto-generated with knowledge (at depth 0)
        let systemPrompt = system;
        if (!systemPrompt && this._defaultSystemPrompt) {
          systemPrompt = this._defaultSystemPrompt;
        }
        if (!systemPrompt && depth === 0) {
          // Don't inject knowledge into system prompt - Claude uses knowledge() tool
          // This ensures fresh data (tool has 2-min cache) vs stale prompt data
          systemPrompt = this._buildSystemPrompt(null);
        }

        // Use passed sequence ID or auto-generate if not provided
        const messageSequenceId = sequenceId || this._UISupport.getNextSequenceId();
        
        // [THINK] Passed as context.think → tools → exec thinking() → sidebar
        const onThinking = (text, seqId) => {
          this._UISupport.storeThinkingMessage(text, seqId, requestId);
        };

        // Track what we add this turn (for snippet)
        const snippet = [];

        // Build content array for this message
        const content = [];

        // Add text if provided (and not empty)
        if (text && text.trim()) {
          content.push({
            type: 'text',
            text: text
          });
        }

        // Add attachments (unified handling for images, PDFs, etc.)
        attachments.forEach(att => {
          if (att.data && att.mediaType) {
            if (att.mediaType.startsWith('image/')) {
              // Image attachment
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: att.mediaType,
                  data: att.data
                }
              });
            } else if (att.mediaType === 'application/pdf') {
              // PDF attachment
              content.push({
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: att.mediaType,
                  data: att.data
                }
              });
            }
          }
        });

        // Add new user message to conversation history
        const userMsg = {
          role: 'user',
          content: content
        };
        const updatedMessages = [...messages, userMsg];
        snippet.push(userMsg);  // Track user message in snippet

        // Get tools based on context.toolsEnabled or all enabled tools
        // Then merge with inline tools (constructor + per-message)
        const registryTools = context.toolsEnabled 
          ? this._getFilteredTools(context.toolsEnabled)
          : this._toolRegistry.getEnabledTools();
        const toolsToUse = this._mergeTools(registryTools, messageTools);

        // Build API request with tools
        const requestBody = {
          model: modelToUse,
          messages: updatedMessages,
          max_tokens: resolvedMaxTokens,
          tools: toolsToUse
        };

        // Add system prompt if available
        if (systemPrompt) {
          requestBody.system = systemPrompt;
        }

        // Add extended thinking if enabled (with budget validation)
        if (enableThinking) {
          // API requires: 1024 <= budget_tokens < max_tokens
          const effectiveBudget = Math.min(this.thinkingBudget, resolvedMaxTokens - 1);
          if (effectiveBudget >= 1024) {
            requestBody.thinking = {
              type: 'enabled',
              budget_tokens: effectiveBudget
            };
          } else {
            Logger.log('[WARN] Thinking budget below minimum (1024), disabling extended thinking');
          }
        }

        // Make API request
        const options = {
          method: 'post',
          contentType: 'application/json',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-fetch-2025-09-10'
          },
          payload: JSON.stringify(requestBody),
          muteHttpExceptions: true
        };

        // Compact API request logging
        const lastMsg = requestBody.messages.length > 0 ? requestBody.messages[requestBody.messages.length - 1] : null;
        const lastContent = lastMsg && Array.isArray(lastMsg.content) && lastMsg.content[0];
        const textPreview = lastContent?.type === 'text' && lastContent.text ? lastContent.text.substring(0, 50) : '';
        Logger.log(`[API_REQUEST] model=${requestBody.model} msgs=${requestBody.messages.length} tokens=${requestBody.max_tokens} tools=${requestBody.tools?.length || 0} sys=${requestBody.system?.length || 0}c think=${requestBody.thinking ? 'Y' : 'N'} last=${lastMsg?.role || '-'}:${lastContent?.type || '-'} "${textPreview}"`);

        // Log tool definitions sent to Claude API (shows exactly what Claude sees)
        if (requestBody.tools?.length > 0) {
          Logger.log(`[API_TOOLS] Sending ${requestBody.tools.length} tools to Claude:`);
          requestBody.tools.forEach(tool => {
            const props = Object.keys(tool.input_schema?.properties || {});
            const req = tool.input_schema?.required || [];
            const desc = (tool.description || '').substring(0, 80).replace(/\n/g, ' ');
            Logger.log(`[API_TOOL] ${tool.name}: (${props.length} props, ${req.length} req) "${desc}..."`);
          });
        }

    // Check for control messages (cancel, pause, etc.)
    try {
      if (typeof checkControlMessages === 'function') {
        checkControlMessages();
      }
    } catch (error) {
      // Handle cancellation gracefully
      if (error.name === 'CancelledError') {
        Logger.log('[ClaudeConversation] Request cancelled: ' + error.message);
        return {
          success: false,
          cancelled: true,
          error: error.message,
          messages: messages,
          thinkingMessages: [],
          usage: {input_tokens: 0, output_tokens: 0}
        };
      }
      // Re-throw other errors
      throw error;
    }
    
        const response = UrlFetchApp.fetch(this.apiUrl, options);
        const statusCode = response.getResponseCode();
        const responseText = response.getContentText();

        if (statusCode !== 200) {
          // Log FULL error details for debugging
          Logger.log('[API_ERROR] Status: ' + statusCode);
          Logger.log('[API_ERROR] Full response: ' + responseText);
          
          // Check for context length exceeded error - invoke ThreadContinuation
          const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');
          if (ClaudeApiUtils.isContextExceededError(responseText)) {
            Logger.log('[ClaudeConversation] Context length exceeded - invoking ThreadContinuation');
            
            const ThreadContinuation = require('sheets-chat/ThreadContinuation');
            
            // Build a minimal conversation object for handleThreadContinuation
            const conversationForContinuation = {
              id: requestId || 'context-exceeded-' + Date.now(),
              messages: updatedMessages,
              memory: context.memory || {},
              inheritedSummary: context.inheritedSummary || null,
              threadSequence: context.threadSequence || 1
            };
            
            // Handle thread continuation - extracts memory, generates summary, compresses context
            const continuationResult = ThreadContinuation.handleThreadContinuation(
              conversationForContinuation,
              text  // The user message that triggered the context exceeded
            );
            
            if (!continuationResult.success) {
              Logger.log('[ClaudeConversation] ThreadContinuation failed: ' + continuationResult.error);
              throw new Error(`Context length exceeded and continuation failed: ${continuationResult.error}`);
            }
            
            Logger.log('[ClaudeConversation] Continuation created new thread: ' + continuationResult.newThread.id);
            
            // Build the continuation context message (memory + summary + historical anchors)
            const contextMessage = this._buildContinuationContext(
              continuationResult.newThread.memory,
              continuationResult.newThread.inheritedSummary,
              continuationResult.newThread.historicalAnchors
            );
            
            // Retry the API call with compressed context:
            // 1. Context message (memory + summary)
            // 2. Recent turns from continuation
            // 3. Current user message (if not already in recent turns)
            const compressedMessages = [
              { role: 'user', content: [{ type: 'text', text: contextMessage }] },
              { role: 'assistant', content: [{ type: 'text', text: 'I understand the context from our previous conversation. I\'ll continue helping you with that in mind.' }] },
              ...continuationResult.newThread.messages
            ];
            
            Logger.log('[ClaudeConversation] Retrying with compressed context: ' + compressedMessages.length + ' messages');
            
            // Recursive call with compressed messages and updated context
            return this.sendMessage({
              ...params,
              messages: compressedMessages,
              context: {
                ...context,
                memory: continuationResult.newThread.memory,
                inheritedSummary: continuationResult.newThread.inheritedSummary,
                threadSequence: continuationResult.newThread.threadSequence,
                threadContinued: true
              }
            });
          }
          
          throw new Error(`Claude API error (${statusCode}): ${responseText}`);
        }

        const result = JSON.parse(responseText);

        // Extract thinking messages
        const thinkingMessages = [];
        const contentBlocks = [];
        const toolUses = [];

        if (result.content && Array.isArray(result.content)) {
          result.content.forEach(block => {
            if (block.type === 'thinking') {
              // Preserve signature for potential verification/caching
              thinkingMessages.push({
                thinking: block.thinking,
                signature: block.signature || null
              });
              // Auto-store thinking via callback
              Logger.log('[THINKING] ' + block.thinking);
              if (onThinking) {
                onThinking(block.thinking, messageSequenceId);
              }
            } else if (block.type === 'text') {
              contentBlocks.push(block.text);
            } else if (block.type === 'tool_use') {
              toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input
              });
            }
          });
        }

        // Add assistant response to messages
        const assistMsg = {
          role: 'assistant',
          content: result.content
        };
        updatedMessages.push(assistMsg);
        
        // For snippet: Filter out thinking-only messages
        // Only include messages that have non-thinking content (text, tool_use, etc.)
        const hasNonThinkingContent = result.content.some(block => 
          block.type !== 'thinking'
        );
        
        if (hasNonThinkingContent) {
          // Create filtered version for snippet (no thinking blocks)
          const filteredContent = result.content.filter(block => 
            block.type !== 'thinking'
          );
          
          const snippetMsg = {
            role: 'assistant',
            content: filteredContent
          };
          snippet.push(snippetMsg);  // Track assistant message in snippet (filtered)
        }
        // If message is thinking-only, don't add to snippet at all

        // LLM-FIX-2026-01-13: Tool execution logs no longer sent to UI thinking display.
        // Previously: [REGISTRY], [TOOL_START], [EXEC_CODE], [TOOL_END], [SENSITIVE] sent via onThinking().
        // Now: Only actual Claude thinking blocks sent to UI. Server logs retained via Logger.log().
        // Rationale: Debug metadata was polluting user-facing thinking bubble.
        
        // Auto-execute tools if present
        if (toolUses.length > 0 && this._toolRegistry) {
          // Emit [REGISTRY] log once at start of tool execution (server-side only)
          const enabledToolNames = this._toolRegistry.getEnabledToolNames().join(',');
          Logger.log(`[REGISTRY] Initialized: tools=${enabledToolNames}`);
          
          const toolResults = toolUses.map(toolUse => {
            // Check for cancellation before each tool execution
            if (typeof checkControlMessages === 'function') {
              checkControlMessages();  // Throws CancelledError if cancelled
            }
            
            // Emit [TOOL_START] log (server-side only)
            const startTime = new Date().getTime();
            const inputJson = this._truncateJson(toolUse.input);
            Logger.log(`[TOOL_START] id=${toolUse.id} tool=${toolUse.name} input=${inputJson}`);
            
            // Log exec code if it's an exec tool (server-side only)
            if (toolUse.name === 'exec' && toolUse.input.jsCode) {
              Logger.log(`[EXEC_CODE] ${toolUse.input.jsCode}`);
            }
            
            // [THINK] Wire thinking() in exec code to sidebar UI
            const execContext = { ...context, think: (msg) => onThinking(msg, messageSequenceId) };
            let toolResult;
            let success = true;
            try {
              // Check inline handlers first (constructor + per-message tools)
              const inlineHandler = this._inlineToolHandlers.get(toolUse.name);
              if (inlineHandler && inlineHandler.execute) {
                // Execute inline tool
                const rawResult = inlineHandler.execute(toolUse.input, execContext);
                toolResult = {
                  success: true,
                  result: rawResult
                };
              } else {
                // Fall back to registry tools
                toolResult = this._toolRegistry.executeToolCall(toolUse.name, toolUse.input, execContext);
              }
              success = toolResult.success !== false;
            } catch (error) {
              toolResult = {
                success: false,
                error: error.toString(),
                message: error.message,
                stack: error.stack,
                name: error.name
              };
              success = false;
            }
            
            // Emit [TOOL_END] log with timing (server-side only)
            const endTime = new Date().getTime();
            const duration = endTime - startTime;
            const resultJson = this._truncateJson(toolResult);
            Logger.log(`[TOOL_END] id=${toolUse.id} tool=${toolUse.name} duration=${duration}ms success=${success} result=${resultJson}`);
            
            // Log [SENSITIVE] for successful exec tool results - NO TRUNCATION (server-side only)
            if (success && toolUse.name === 'exec' && toolResult.result !== undefined) {
              const resultJson = JSON.stringify(toolResult.result);
              Logger.log(`[SENSITIVE] ${resultJson}`);
            }
            
            // Format result for Claude (handles PDFs/images as content blocks)
            const contentForClaude = this._formatToolResultContent(toolResult);
            
            return {
              tool_use_id: toolUse.id,
              content: contentForClaude
            };
          });
          
          // Automatically send tool results and get final response
          return this._sendToolResults(updatedMessages, toolResults, snippet, onThinking, messageSequenceId, systemPrompt, context, toolsToUse, modelToUse, enableThinking);
        }

        return {
          response: contentBlocks.join('\n'),
          message: {
            role: 'assistant',
            content: result.content
          },
          messages: updatedMessages,  // Full conversation (backward compat)
          threadHistorySnippet: snippet,  // Delta from this turn
          usage: result.usage,
          thinkingMessages: thinkingMessages,
          toolUses: toolUses,
          stopReason: result.stop_reason,
          sequenceId: messageSequenceId,
          context: context
        };
      }

      /**
       * Get filtered tool definitions based on allowed tool names
       * @private
       * @param {Array<string>} allowedTools - Array of tool names to include
       * @returns {Array} Filtered tool definitions
       */
      _getFilteredTools(allowedTools) {
        const allTools = this._toolRegistry.getEnabledTools();
        return allTools.filter(tool => allowedTools.includes(tool.name));
      }

      /**
       * Internal method - Continue conversation with tool results
       * @private
       */
      _sendToolResults(messages, toolResults, snippet, onThinking, sequenceId, system, context, toolsToUse, modelToUse, enableThinking = true) {
        // Add tool result message
        const toolResultContent = toolResults.map(result => ({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content
        }));

        const toolResultMsg = {
          role: 'user',
          content: toolResultContent
        };
        const updatedMessages = [...messages, toolResultMsg];
        snippet.push(toolResultMsg);  // Track tool result message in snippet

        // Make direct API call with tool results
        const { getConfig } = require('sheets-chat/ChatConstants');
        const maxTokens = getConfig('MAX_RESPONSE_TOKENS');
        const requestBody = {
          model: modelToUse,
          messages: updatedMessages,
          max_tokens: maxTokens,
          tools: toolsToUse
        };

        // Add thinking with budget validation (same as sendMessage) - only if enabled
        if (enableThinking) {
          const effectiveBudget = Math.min(this.thinkingBudget, maxTokens - 1);
          if (effectiveBudget >= 1024) {
            requestBody.thinking = {
              type: 'enabled',
              budget_tokens: effectiveBudget
            };
          }
        }

        // Add system prompt if provided
        if (system) {
          requestBody.system = system;
        }

        const options = {
          method: 'post',
          contentType: 'application/json',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-fetch-2025-09-10'
          },
          payload: JSON.stringify(requestBody),
          muteHttpExceptions: true
        };

        const response = UrlFetchApp.fetch(this.apiUrl, options);
        const statusCode = response.getResponseCode();
        const responseText = response.getContentText();

    // Check for control messages (cancel, pause, etc.)
    try {
      if (typeof checkControlMessages === 'function') {
        checkControlMessages();
      }
    } catch (error) {
      if (error.name === 'CancelledError') {
        Logger.log('[ClaudeConversation] Request cancelled in tool results: ' + error.message);
        return {
          success: false,
          cancelled: true,
          error: error.message,
          messages: messages,
          thinkingMessages: [],
          usage: {input_tokens: 0, output_tokens: 0}
        };
      }
      throw error;
    }
    
        if (statusCode !== 200) {
          // Log error details
          Logger.log('[API_ERROR] Tool results - Status: ' + statusCode);
          Logger.log('[API_ERROR] Tool results - Response: ' + responseText.substring(0, 500));
          
          // Check for context length exceeded in tool results flow
          const ClaudeApiUtils = require('sheets-chat/ClaudeApiUtils');
          if (ClaudeApiUtils.isContextExceededError(responseText)) {
            Logger.log('[ClaudeConversation] Context length exceeded during tool execution - this is rare but can happen with large tool results');
            // For tool results, we throw a descriptive error rather than trying to continue
            // because we're mid-tool-execution and the context is complex
            throw new Error('Context length exceeded during tool execution. The conversation is too long. Please start a new conversation.');
          }
          
          throw new Error(`Claude API error (${statusCode}): ${responseText}`);
        }

        const result = JSON.parse(responseText);

        // Extract content
        const thinkingMessages = [];
        const contentBlocks = [];
        const toolUses = [];

        if (result.content && Array.isArray(result.content)) {
          result.content.forEach(block => {
            if (block.type === 'thinking') {
              // Preserve signature for potential verification/caching
              thinkingMessages.push({
                thinking: block.thinking,
                signature: block.signature || null
              });
              Logger.log('[THINKING] ' + block.thinking);
              if (onThinking) {
                onThinking(block.thinking, sequenceId);
              }
            } else if (block.type === 'text') {
              contentBlocks.push(block.text);
            } else if (block.type === 'tool_use') {
              toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input
              });
            }
          });
        }

        // Add assistant response to messages
        const assistMsg = {
          role: 'assistant',
          content: result.content
        };
        updatedMessages.push(assistMsg);

        // For snippet: Filter out thinking-only messages
        // Only include messages that have non-thinking content (text, tool_use, etc.)
        const hasNonThinkingContent = result.content.some(block =>
          block.type !== 'thinking'
        );

        if (hasNonThinkingContent) {
          // Create filtered version for snippet (no thinking blocks)
          const filteredContent = result.content.filter(block =>
            block.type !== 'thinking'
          );

          const snippetMsg = {
            role: 'assistant',
            content: filteredContent
          };
          snippet.push(snippetMsg);  // Track assistant message in snippet (filtered)
        }
        // If message is thinking-only, don't add to snippet at all

        // Check if there are more tool calls
        if (toolUses.length > 0) {
          // LLM-FIX-2026-01-13: Tool execution logs no longer sent to UI thinking display.
          // Previously: [TOOL_START], [EXEC_CODE], [TOOL_END], [SENSITIVE] sent via onThinking().
          // Now: Only actual Claude thinking blocks sent to UI. Server logs retained via Logger.log().
          // Rationale: Debug metadata was polluting user-facing thinking bubble.
          
          // Don't emit [REGISTRY] again - already done in first call
          const toolResults2 = toolUses.map(toolUse => {
            // Check for cancellation before each tool execution
            if (typeof checkControlMessages === 'function') {
              checkControlMessages();  // Throws CancelledError if cancelled
            }
            
            const startTime = new Date().getTime();
            const inputJson = this._truncateJson(toolUse.input);
            Logger.log(`[TOOL_START] id=${toolUse.id} tool=${toolUse.name} input=${inputJson}`);
            
            // Log exec code if it's an exec tool (server-side only)
            if (toolUse.name === 'exec' && toolUse.input.jsCode) {
              Logger.log(`[EXEC_CODE] ${toolUse.input.jsCode}`);
            }
            
            // [THINK] Wire thinking() in exec code to sidebar UI
            const execContext = { ...context, think: (msg) => onThinking(msg, sequenceId) };
            let toolResult;
            let success = true;
            try {
              // Check inline handlers first (constructor + per-message tools)
              const inlineHandler = this._inlineToolHandlers.get(toolUse.name);
              if (inlineHandler && inlineHandler.execute) {
                // Execute inline tool
                const rawResult = inlineHandler.execute(toolUse.input, execContext);
                toolResult = {
                  success: true,
                  result: rawResult
                };
              } else {
                // Fall back to registry tools
                toolResult = this._toolRegistry.executeToolCall(toolUse.name, toolUse.input, execContext);
              }
              success = toolResult.success !== false;
            } catch (error) {
              toolResult = {
                success: false,
                error: error.toString(),
                message: error.message,
                stack: error.stack,
                name: error.name
              };
              success = false;
            }
            
            const endTime = new Date().getTime();
            const duration = endTime - startTime;
            const resultJson = this._truncateJson(toolResult);
            Logger.log(`[TOOL_END] id=${toolUse.id} tool=${toolUse.name} duration=${duration}ms success=${success} result=${resultJson}`);
            
            // Log [SENSITIVE] for successful exec tool results - NO TRUNCATION (server-side only)
            if (success && toolUse.name === 'exec' && toolResult.result !== undefined) {
              const sensitiveJson = JSON.stringify(toolResult.result);
              Logger.log(`[SENSITIVE] ${sensitiveJson}`);
            }
            
            // Format result for Claude (handles PDFs/images as content blocks)
            const contentForClaude = this._formatToolResultContent(toolResult);
            
            return {
              tool_use_id: toolUse.id,
              content: contentForClaude
            };
          });
          
          // LLM-FIX-2026-01-13: Changed execContext to context - execContext was defined inside map() callback scope,
          // not accessible here. The think callback is already passed via onThinking parameter.
          return this._sendToolResults(updatedMessages, toolResults2, snippet, onThinking, sequenceId, system, context, toolsToUse, modelToUse, enableThinking);
        }

        return {
          response: contentBlocks.join('\n'),
          message: {
            role: 'assistant',
            content: result.content
          },
          messages: updatedMessages,  // Full conversation (backward compat)
          threadHistorySnippet: snippet,  // Delta from this turn
          usage: result.usage,
          thinkingMessages: thinkingMessages,
          toolUses: toolUses,
          stopReason: result.stop_reason,
          sequenceId: sequenceId,
          context: context
        };
      }

      /**
       * Load knowledge from "Knowledge" sheet via exec tool
       * IMPORTANT: This method NEVER caches - always reads fresh data from sheet
       * @private
       * @returns {Array|null} Knowledge data as JSON array or null if not available
       */
      _loadKnowledge() {
        try {
          // Use exec tool to read Knowledge sheet as raw 2D array
          // NO CACHING: Reads fresh data every time this is called
          const execResult = this._toolRegistry.executeToolCall('exec', {
            jsCode: `
              // Flush any pending spreadsheet operations to ensure fresh read
              SpreadsheetApp.flush();
              
              const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Knowledge');
              if (!sheet) return null;
              
              // Always fetch fresh data - no caching
              const data = sheet.getDataRange().getValues();
              if (data.length === 0) return null;
              
              // Return raw 2D array
              return data;
            `
          }, { depth: 0 });
          
          return execResult.success ? execResult.result : null;
        } catch (error) {
          Logger.log('[KNOWLEDGE] Failed to load: ' + error);
          return null;
        }
      }

      /**
       * Load custom system prompt from _SheetsChat tab (if exists)
       * Checks column A for "SystemPrompt" key and reads value from column B
       * @private
       * @returns {string|null} Custom prompt or null if not found
       */
      _loadCustomSystemPrompt() {
        // Return cached value if already loaded
        if (this._customSystemPrompt !== undefined) {
          return this._customSystemPrompt;
        }
        
        try {
          const ss = SpreadsheetApp.getActiveSpreadsheet();
          const configSheet = ss.getSheetByName('_SheetsChat');
          
          if (!configSheet) {
            this._customSystemPrompt = null;
            return null;
          }
          
          // Read all data from columns A and B
          const data = configSheet.getDataRange().getValues();
          
          // Search for "SystemPrompt" key in column A
          for (let i = 0; i < data.length; i++) {
            if (data[i][0] === 'SystemPrompt') {
              const customPrompt = data[i][1];
              
              if (customPrompt && typeof customPrompt === 'string' && customPrompt.trim()) {
                // Cache the custom prompt
                this._customSystemPrompt = customPrompt;
                
                Logger.log(`[SystemPrompt] Loaded custom system prompt from _SheetsChat tab (${customPrompt.length} characters)`);
                return customPrompt;
              }
            }
          }
          
          // Not found
          this._customSystemPrompt = null;
          return null;
        } catch (error) {
          Logger.log('[SystemPrompt] Error loading custom prompt: ' + error);
          this._customSystemPrompt = null;
          return null;
        }
      }

      /**
       * Build context message for thread continuation
       * Combines memory, summary, and historical anchors into a user-friendly context block
       * @private
       * @param {Object} memory - Extracted semantic memory {entities, facts, currentGoal}
       * @param {string} summary - Episodic summary of previous conversation
       * @param {Array} historicalAnchors - Array of anchor entries from past threads
       * @returns {string} Formatted context message for injection into conversation
       */
      _buildContinuationContext(memory, summary, historicalAnchors) {
        const parts = [];
        
        parts.push('## Context from Previous Conversation');
        parts.push('');
        parts.push('The previous conversation exceeded the context limit. Here is the preserved context:');
        parts.push('');
        
        // Add summary if available
        if (summary) {
          parts.push('### Conversation Summary');
          parts.push(summary);
          parts.push('');
        }
        
        // Add memory if available
        if (memory) {
          if (memory.currentGoal) {
            parts.push('### Current Goal');
            parts.push(memory.currentGoal);
            parts.push('');
          }
          
          if (memory.facts && memory.facts.length > 0) {
            parts.push('### Key Facts');
            memory.facts.slice(0, 15).forEach(fact => {
              parts.push('- ' + fact);
            });
            parts.push('');
          }
          
          if (memory.entities && Object.keys(memory.entities).length > 0) {
            parts.push('### Relevant Entities');
            Object.entries(memory.entities).slice(0, 10).forEach(([key, value]) => {
              if (Array.isArray(value)) {
                parts.push('- ' + key + ': ' + value.slice(0, 5).join(', '));
              } else {
                parts.push('- ' + key + ': ' + String(value).substring(0, 100));
              }
            });
            parts.push('');
          }
        }
        
        // Add historical anchors if available (formatted table)
        if (historicalAnchors && historicalAnchors.length > 0) {
          parts.push(this._UISupport.formatHistoricalAnchors(historicalAnchors));
          parts.push('');
        }
        
        parts.push('Please continue helping with the task, using this context as reference.');
        
        return parts.join('\n');
      }

      /**
       * Build system prompt with tool descriptions and knowledge
       * Checks for custom prompt in _SheetsChat tab first, falls back to default
       * Gathers environment context at prompt initialization to eliminate first-turn probing
       * @private
       * @param {Array|null} knowledge - Knowledge data to inject
       * @returns {string} Complete system prompt
       */
      _buildSystemPrompt(knowledge = null) {
        // Try to load custom system prompt first
        const customPrompt = this._loadCustomSystemPrompt();
        if (customPrompt) {
          Logger.log('[SystemPrompt] Using custom prompt from _SheetsChat tab');
          return customPrompt;
        }
        
        // Gather environment context at prompt initialization
        // This eliminates the first round-trip where Claude probes for context
        const envContext = this._SystemPrompt.gatherEnvironmentContext();
        Logger.log('[SystemPrompt] Environment context gathered: ' + (envContext?.type || 'unknown'));
        
        // Fall back to default with environment context
        Logger.log('[SystemPrompt] Using default prompt with environment context');
        return this._SystemPrompt.buildSystemPromptV2a(knowledge, null, envContext);
      }

      /**
       * Clear conversation (client-side operation)
       * Returns empty messages array
       */
      clearConversation() {
        // Reset tool registry toolState
        if (this._toolRegistry) {
          this._toolRegistry.resetToolState();
        }
        return [];
      }

      // =========================================================================
      // INTERNAL KNOWLEDGE MANAGEMENT TOOLS
      // These methods allow Claude to manage the Knowledge sheet programmatically
      // =========================================================================

      /**
       * Append new knowledge entry to the Knowledge sheet
       * @param {Object} input - Tool input
       * @param {string} input.type - Knowledge type/category (column A)
       * @param {string} input.key - Knowledge key/identifier (column B)  
       * @param {string} input.value - Knowledge value/content (column C)
       * @param {Object} context - Execution context
       * @returns {Object} Result with success status and row number
       */
      _appendKnowledge(input, context = {}) {
        try {
          const { type, key, value } = input;
          
          if (!type || !key) {
            return { success: false, error: 'type and key are required' };
          }
          
          const ss = SpreadsheetApp.getActiveSpreadsheet();
          let sheet = ss.getSheetByName('Knowledge');
          
          // Create sheet if it doesn't exist
          if (!sheet) {
            sheet = ss.insertSheet('Knowledge');
            // Add headers
            sheet.getRange(1, 1, 1, 3).setValues([['Type', 'Key', 'Value']]);
            sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
          }
          
          // Append new row - coerce non-string values to JSON
          const safeValue = value !== undefined
            ? (typeof value === 'string' ? value : JSON.stringify(value))
            : '';
          const newRow = [type, key, safeValue];
          sheet.appendRow(newRow);
          
          const lastRow = sheet.getLastRow();
          
          // Clear KnowledgeToolHandler cache if accessible
          this._clearKnowledgeCache();
          
          Logger.log(`[KNOWLEDGE] Appended: type=${type}, key=${key}, row=${lastRow}`);
          
          return {
            success: true,
            result: {
              action: 'append',
              row: lastRow,
              type,
              key,
              value: safeValue
            }
          };
        } catch (error) {
          Logger.log(`[KNOWLEDGE] Append error: ${error.message}`);
          return { success: false, error: error.message };
        }
      }

      /**
       * Update existing knowledge entry in the Knowledge sheet
       * @param {Object} input - Tool input
       * @param {number} input.row - Row number to update (optional if using key match)
       * @param {string} input.matchKey - Find entry by key (optional if using row)
       * @param {string} input.matchType - Type to match with key (optional, narrows search)
       * @param {string} input.type - New type value (optional)
       * @param {string} input.key - New key value (optional)
       * @param {string} input.value - New value (optional)
       * @param {Object} context - Execution context
       * @returns {Object} Result with success status
       */
      _updateKnowledge(input, context = {}) {
        try {
          const { row, matchKey, matchType, type, key, value } = input;

          // Early validation: require either row or matchKey
          if (!row && !matchKey) {
            return { success: false, error: 'Either row or matchKey is required to identify the entry to update' };
          }

          const ss = SpreadsheetApp.getActiveSpreadsheet();
          const sheet = ss.getSheetByName('Knowledge');
          
          if (!sheet) {
            return { success: false, error: 'Knowledge sheet not found' };
          }
          
          let targetRow = row;
          
          // Find row by key match if row not provided
          if (!targetRow && matchKey) {
            const data = sheet.getDataRange().getValues();
            for (let i = 1; i < data.length; i++) {  // Skip header row
              const rowType = String(data[i][0] || '').toLowerCase();
              const rowKey = String(data[i][1] || '');
              
              if (rowKey === matchKey) {
                if (!matchType || rowType === matchType.toLowerCase()) {
                  targetRow = i + 1;  // Sheet rows are 1-indexed
                  break;
                }
              }
            }
            
            if (!targetRow) {
              return { 
                success: false, 
                error: `No entry found with key "${matchKey}"${matchType ? ` and type "${matchType}"` : ''}` 
              };
            }
          }
          
          if (!targetRow || targetRow < 2) {
            return { success: false, error: 'Valid row number required (must be > 1 to skip header)' };
          }
          
          // Get current values
          const currentValues = sheet.getRange(targetRow, 1, 1, 3).getValues()[0];

          // Coerce non-string values to JSON
          const safeValue = value !== undefined
            ? (typeof value === 'string' ? value : JSON.stringify(value))
            : currentValues[2];

          // Update only provided fields
          const newValues = [
            type !== undefined ? type : currentValues[0],
            key !== undefined ? key : currentValues[1],
            safeValue
          ];
          
          sheet.getRange(targetRow, 1, 1, 3).setValues([newValues]);
          
          // Clear cache
          this._clearKnowledgeCache();
          
          Logger.log(`[KNOWLEDGE] Updated row ${targetRow}: ${JSON.stringify(newValues)}`);
          
          return {
            success: true,
            result: {
              action: 'update',
              row: targetRow,
              previous: { type: currentValues[0], key: currentValues[1], value: currentValues[2] },
              updated: { type: newValues[0], key: newValues[1], value: newValues[2] }
            }
          };
        } catch (error) {
          Logger.log(`[KNOWLEDGE] Update error: ${error.message}`);
          return { success: false, error: error.message };
        }
      }

      /**
       * Delete knowledge entry from the Knowledge sheet
       * @param {Object} input - Tool input
       * @param {number} input.row - Row number to delete (optional if using key match)
       * @param {string} input.matchKey - Find entry by key (optional if using row)
       * @param {string} input.matchType - Type to match with key (optional, narrows search)
       * @param {Object} context - Execution context
       * @returns {Object} Result with success status and deleted entry
       */
      _deleteKnowledge(input, context = {}) {
        try {
          const { row, matchKey, matchType } = input;

          // Early validation: require either row or matchKey
          if (!row && !matchKey) {
            return { success: false, error: 'Either row or matchKey is required to identify the entry to delete' };
          }

          const ss = SpreadsheetApp.getActiveSpreadsheet();
          const sheet = ss.getSheetByName('Knowledge');
          
          if (!sheet) {
            return { success: false, error: 'Knowledge sheet not found' };
          }
          
          let targetRow = row;
          
          // Find row by key match if row not provided
          if (!targetRow && matchKey) {
            const data = sheet.getDataRange().getValues();
            for (let i = 1; i < data.length; i++) {  // Skip header row
              const rowType = String(data[i][0] || '').toLowerCase();
              const rowKey = String(data[i][1] || '');
              
              if (rowKey === matchKey) {
                if (!matchType || rowType === matchType.toLowerCase()) {
                  targetRow = i + 1;  // Sheet rows are 1-indexed
                  break;
                }
              }
            }
            
            if (!targetRow) {
              return { 
                success: false, 
                error: `No entry found with key "${matchKey}"${matchType ? ` and type "${matchType}"` : ''}` 
              };
            }
          }
          
          if (!targetRow || targetRow < 2) {
            return { success: false, error: 'Valid row number required (must be > 1 to skip header)' };
          }
          
          // Get values before deletion
          const deletedValues = sheet.getRange(targetRow, 1, 1, 3).getValues()[0];
          
          // Delete the row
          sheet.deleteRow(targetRow);
          
          // Clear cache
          this._clearKnowledgeCache();
          
          Logger.log(`[KNOWLEDGE] Deleted row ${targetRow}: ${JSON.stringify(deletedValues)}`);
          
          return {
            success: true,
            result: {
              action: 'delete',
              row: targetRow,
              deleted: { type: deletedValues[0], key: deletedValues[1], value: deletedValues[2] }
            }
          };
        } catch (error) {
          Logger.log(`[KNOWLEDGE] Delete error: ${error.message}`);
          return { success: false, error: error.message };
        }
      }

      /**
       * Clear KnowledgeToolHandler cache after modifications
       * @private
       */
      _clearKnowledgeCache() {
        try {
          // Access the knowledge handler through registry and clear its cache
          if (this._toolRegistry && this._toolRegistry._handlers) {
            const knowledgeHandler = this._toolRegistry._handlers.get('knowledge');
            if (knowledgeHandler && typeof knowledgeHandler.clearCache === 'function') {
              knowledgeHandler.clearCache();
              Logger.log('[KNOWLEDGE] Cache cleared');
            }
          }
        } catch (e) {
          // Cache clearing is best-effort
          Logger.log('[KNOWLEDGE] Could not clear cache: ' + e.message);
        }
      }

      /**
       * Get internal knowledge management tools definitions
       * These are available as inline tools for knowledge CRUD operations
       * @returns {Array} Array of tool definitions with execute functions
       */
      _getKnowledgeManagementTools() {
        return [
          {
            name: 'append_knowledge',
            description: 'Add a new entry to the Knowledge sheet - a persistent repository that survives across all conversations and API interactions. Creates sheet with headers if it doesn\'t exist. Note: Does NOT check for duplicates - if type+key already exists, creates another row. Use update_knowledge to modify existing entries. Non-string values are JSON stringified.',
            input_schema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description: 'Category/type of knowledge (e.g., "general", "url_pattern", "config", "alias")'
                },
                key: {
                  type: 'string',
                  description: 'Unique identifier or name for this knowledge entry'
                },
                value: {
                  type: 'string',
                  description: 'The knowledge content, instructions, or data'
                }
              },
              required: ['type', 'key']
            },
            execute: (input, context) => this._appendKnowledge(input, context)
          },
          {
            name: 'update_knowledge',
            description: 'Update an existing entry in the persistent Knowledge repository (persists across all conversations). REQUIRES either: (1) row - the exact row number (1-indexed, >1), or (2) matchKey - finds first entry matching this key value. Optionally add matchType to narrow search. Only provided fields (type/key/value) are updated. Non-string values are JSON stringified.',
            input_schema: {
              type: 'object',
              properties: {
                row: {
                  type: 'number',
                  description: 'Row number to update (1-indexed, must be > 1 to skip header)'
                },
                matchKey: {
                  type: 'string',
                  description: 'Find entry by key value (alternative to row number)'
                },
                matchType: {
                  type: 'string',
                  description: 'Narrow key search to specific type (optional)'
                },
                type: {
                  type: 'string',
                  description: 'New type value (optional - only updates if provided)'
                },
                key: {
                  type: 'string',
                  description: 'New key value (optional - only updates if provided)'
                },
                value: {
                  type: 'string',
                  description: 'New value (optional - only updates if provided)'
                }
              },
              required: []
            },
            execute: (input, context) => this._updateKnowledge(input, context)
          },
          {
            name: 'delete_knowledge',
            description: 'Delete an entry from the persistent Knowledge repository (changes are permanent across all conversations). REQUIRES either: (1) row - the exact row number (1-indexed, >1), or (2) matchKey - finds first entry matching this key value. Optionally add matchType to narrow search. Returns the deleted entry data.',
            input_schema: {
              type: 'object',
              properties: {
                row: {
                  type: 'number',
                  description: 'Row number to delete (1-indexed, must be > 1 to skip header)'
                },
                matchKey: {
                  type: 'string',
                  description: 'Find entry by key value (alternative to row number)'
                },
                matchType: {
                  type: 'string',
                  description: 'Narrow key search to specific type (optional)'
                }
              },
              required: []
            },
            execute: (input, context) => this._deleteKnowledge(input, context)
          }
        ];
      }
    }

    // Export for CommonJS
    module.exports = ClaudeConversation;
}

__defineModule__(_main);