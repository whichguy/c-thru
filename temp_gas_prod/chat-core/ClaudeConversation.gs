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

        // Auto-require ChatService for infrastructure
        const ChatService = require('chat-core/ChatService');
        this._ChatService = ChatService;

        // Use provided API key or get from ChatService
        this.apiKey = apiKey || ChatService.getApiKey();

        // Read model from constructor param, ConfigManager, or use default
        if (model) {
          this.model = model;
        } else {
          const ConfigManager = require('gas-properties/ConfigManager');
          const config = new ConfigManager('CLAUDE_CHAT');
          this.model = config.get('MODEL_NAME') || 'claude-sonnet-4-6';
        }

        // Use centralized constants for thinking budget and API URL
        const { getConfig } = require('chat-core/ChatConstants');
        this.thinkingBudget = getConfig('THINKING_BUDGET_TOKENS');
        this.apiUrl = getConfig('CLAUDE_API_BASE_URL') + '/v1/messages';

        // Use injected ToolRegistry or try-catch fallback for backward compatibility
        if (options.toolRegistry) {
          this._toolRegistry = options.toolRegistry;
        } else {
          try {
            const ToolRegistry = require('tools/ToolRegistry');
            this._toolRegistry = new ToolRegistry({
              enableExec: true,
              enableSearch: true,
              enableKnowledge: true,
              enablePrompt: true,
              enableAnalyzeUrl: true
            });
          } catch (e) {
            log(`[ClaudeConversation] No ToolRegistry available: ${e.message}`);
            this._toolRegistry = null;
          }
        }

        // Pre-load SystemPrompt module to avoid timing issues
        const SystemPrompt = require('chat-core/SystemPrompt');
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

        // Store knowledge provider (optional - Sheets passes SheetsKnowledgeProvider,
        // Gmail add-on passes nothing → no knowledge tools registered)
        this._knowledgeProvider = options.knowledgeProvider || null;

        // Register knowledge management tools only when provider exists
        if (this._knowledgeProvider) {
          const knowledgeTools = this._getKnowledgeManagementTools();
          knowledgeTools.forEach(tool => {
            this._inlineTools.push(tool);
            this._inlineToolHandlers.set(tool.name, tool);
          });
        }

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
        const requestContext = this.buildRequest(params);
        return this.execute(requestContext);
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
       * Parse response content into thinking messages, content blocks, and tool uses
       * @private
       * @param {Array} content - Response content array from Claude API
       * @param {Function} onThinking - Thinking callback
       * @param {string} sequenceId - Message sequence ID
       * @returns {Object} { thinkingMessages, contentBlocks, toolUses }
       */
      _parseResponseContent(content, onThinking, sequenceId) {
        const thinkingMessages = [];
        const contentBlocks = [];
        const toolUses = [];

        if (content && Array.isArray(content)) {
          content.forEach(block => {
            if (block.type === 'thinking') {
              thinkingMessages.push({
                thinking: block.thinking,
                signature: block.signature || null
              });
              log(`[THINKING] ${block.thinking}`);
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

        return { thinkingMessages, contentBlocks, toolUses };
      }

      /**
       * Add assistant message to snippet, filtering out thinking-only messages
       * @private
       * @param {Array} snippet - Snippet array (mutated in place)
       * @param {Array} resultContent - Raw response content from Claude API
       */
      _addAssistantToSnippet(snippet, resultContent) {
        const hasNonThinkingContent = resultContent.some(block =>
          block.type !== 'thinking'
        );

        if (hasNonThinkingContent) {
          const filteredContent = resultContent.filter(block =>
            block.type !== 'thinking'
          );
          snippet.push({
            role: 'assistant',
            content: filteredContent
          });
        }
        // If message is thinking-only, don't add to snippet at all
      }

      /**
       * Execute tool calls and return formatted results for Claude API
       * @private
       * @param {Array} toolUses - Array of { id, name, input } tool use objects
       * @param {Object} context - Execution context
       * @param {Function} onThinking - Thinking callback
       * @param {string} sequenceId - Message sequence ID
       * @returns {Array} Array of { tool_use_id, content } result objects
       */
      _executeToolCalls(toolUses, context, onThinking, sequenceId) {
        return toolUses.map(toolUse => {
          // Check for cancellation before each tool execution
          if (typeof checkControlMessages === 'function') {
            checkControlMessages();  // Throws CancelledError if cancelled
          }

          // Emit [TOOL_START] log (server-side only)
          const startTime = new Date().getTime();
          const inputJson = this._truncateJson(toolUse.input);
          log(`[TOOL_START] id=${toolUse.id} tool=${toolUse.name} input=${inputJson}`);

          // Log exec code if it's an exec tool (server-side only)
          if (toolUse.name === 'exec' && toolUse.input.jsCode) {
            log(`[EXEC_CODE] ${toolUse.input.jsCode}`);
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
            } else if (this._toolRegistry) {
              // Fall back to registry tools
              toolResult = this._toolRegistry.executeToolCall(toolUse.name, toolUse.input, execContext);
            } else {
              toolResult = { success: false, error: `No tool registry available to execute: ${toolUse.name}` };
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
          log(`[TOOL_END] id=${toolUse.id} tool=${toolUse.name} duration=${duration}ms success=${success} result=${resultJson}`);

          // Log [SENSITIVE] for successful exec tool results - NO TRUNCATION (server-side only)
          if (success && toolUse.name === 'exec' && toolResult.result !== undefined) {
            const sensitiveJson = JSON.stringify(toolResult.result);
            log(`[SENSITIVE] ${sensitiveJson}`);
          }

          // Format result for Claude (handles PDFs/images as content blocks)
          const contentForClaude = this._formatToolResultContent(toolResult);

          return {
            tool_use_id: toolUse.id,
            content: contentForClaude
          };
        });
      }

      /**
       * Build a request context from message parameters — inspect before executing
       *
       * @param {Object} params - Same parameters as sendMessage()
       * @returns {Object} RequestContext with inspectable fields:
       *   - model: Resolved model name
       *   - systemPrompt: Resolved system prompt string
       *   - tools: Merged tool definitions (API-ready schemas)
       *   - thinking: Thinking config or null
       *   - maxTokens: Resolved max tokens
       *   - messages: Conversation with user message appended
       *   - snippet: Delta tracking array for this turn
       *   - onThinking: Resolved thinking callback
       *   - sequenceId: Message sequence ID
       *   - context: Execution context
       *   - requestId: Request ID
       *   - enableThinking: Whether thinking is enabled
       *   - headers: API request headers
       *   - params: Original params (for ThreadContinuation recovery)
       */
      buildRequest(params) {
        const {
          messages = [],
          text,
          system = null,
          context = {},
          attachments = [],
          maxTokens = null,
          enableThinking = true,
          requestId,
          sequenceId,
          model = null,
          tools: messageTools = null,
          onThinking: callerOnThinking = null
        } = params;

        // Use provided model or fall back to constructor's model
        const modelToUse = model || this.model;

        // Resolve maxTokens from ChatConstants if not provided
        const { getConfig } = require('chat-core/ChatConstants');
        const resolvedMaxTokens = maxTokens || getConfig('MAX_RESPONSE_TOKENS');

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
          systemPrompt = this._buildSystemPrompt(null);
        }

        // Use passed sequence ID or auto-generate if not provided
        const messageSequenceId = sequenceId || this._ChatService.getNextSequenceId();

        // [THINK] Use caller-supplied onThinking (includes cancellation check + error suppression).
        // Fall back to internal closure for direct calls (e.g. recursive compaction retry).
        const onThinking = callerOnThinking
          ? (thinkingText, seqId) => {
              if (!requestId) return;
              callerOnThinking(thinkingText, seqId);
            }
          : (thinkingText, seqId) => {
              if (!requestId) return;
              try {
                this._ChatService.storeThinkingMessage(thinkingText, seqId, requestId);
              } catch (e) {
                log(`[ClaudeConversation] onThinking error (non-fatal): ${e.message}`);
              }
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
        const registryTools = this._toolRegistry
          ? (context.toolsEnabled
              ? this._getFilteredTools(context.toolsEnabled)
              : this._toolRegistry.getEnabledTools())
          : [];
        const tools = this._mergeTools(registryTools, messageTools);

        // Build thinking config
        let thinking = null;
        if (enableThinking) {
          // API requires: 1024 <= budget_tokens < max_tokens
          const effectiveBudget = Math.min(this.thinkingBudget, resolvedMaxTokens - 1);
          if (effectiveBudget >= 1024) {
            thinking = {
              type: 'enabled',
              budget_tokens: effectiveBudget
            };
          } else {
            log('[WARN] Thinking budget below minimum (1024), disabling extended thinking');
          }
        }

        return {
          // Inspectable
          model: modelToUse,
          systemPrompt,
          tools,
          thinking,
          maxTokens: resolvedMaxTokens,
          // Execution state
          messages: updatedMessages,
          snippet,
          onThinking,
          sequenceId: messageSequenceId,
          context,
          requestId,
          enableThinking: enableThinking !== false,
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-fetch-2025-09-10'
          },
          params  // original params — needed by ThreadContinuation recovery
        };
      }

      /**
       * Execute a built request context with iterative tool loop
       * Mutates requestContext.messages and requestContext.snippet in-place
       *
       * @param {Object} requestContext - Built request from buildRequest()
       * @returns {Object} Same result shape as sendMessage()
       */
      execute(requestContext) {
        const { messages, snippet, onThinking, sequenceId, context,
                model, maxTokens, tools, systemPrompt, thinking, headers,
                requestId } = requestContext;

        let isFirstCall = true;
        const allThinkingMessages = [];

        while (true) {
          // Check cancellation
          try {
            if (typeof checkControlMessages === 'function') {
              checkControlMessages();
            }
          } catch (error) {
            if (error.name === 'CancelledError') {
              log(`[ClaudeConversation] Request cancelled: ${error.message}`);
              return {
                success: false,
                cancelled: true,
                error: error.message,
                messages,
                thinkingMessages: allThinkingMessages,
                usage: { input_tokens: 0, output_tokens: 0 }
              };
            }
            throw error;
          }

          // Build request body for this iteration (messages may have grown)
          const requestBody = { model, messages, max_tokens: maxTokens };
          if (tools && tools.length > 0) requestBody.tools = tools;
          if (systemPrompt) requestBody.system = systemPrompt;
          if (thinking) requestBody.thinking = thinking;

          // Log API request (first call only — detailed)
          if (isFirstCall) {
            const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
            const lastContent = lastMsg && Array.isArray(lastMsg.content) && lastMsg.content[0];
            const textPreview = lastContent?.type === 'text' && lastContent.text ? lastContent.text.substring(0, 50) : '';
            log(`[API_REQUEST] model=${model} msgs=${messages.length} tokens=${maxTokens} tools=${tools?.length || 0} sys=${systemPrompt?.length || 0}c think=${thinking ? 'Y' : 'N'} last=${lastMsg?.role || '-'}:${lastContent?.type || '-'} "${textPreview}"`);

            if (tools?.length > 0) {
              log(`[API_TOOLS] Sending ${tools.length} tools to Claude:`);
              tools.forEach(tool => {
                const props = Object.keys(tool.input_schema?.properties || {});
                const req = tool.input_schema?.required || [];
                const desc = (tool.description || '').substring(0, 80).replace(/\n/g, ' ');
                log(`[API_TOOL] ${tool.name}: (${props.length} props, ${req.length} req) "${desc}..."`);
              });
            }
          }

          // Fetch
          const response = UrlFetchApp.fetch(this.apiUrl, {
            method: 'post',
            contentType: 'application/json',
            headers,
            payload: JSON.stringify(requestBody),
            muteHttpExceptions: true
          });
          const statusCode = response.getResponseCode();
          const responseText = response.getContentText();

          // Error handling
          if (statusCode !== 200) {
            log(`[API_ERROR] Status: ${statusCode}`);
            log(`[API_ERROR] Full response: ${responseText.substring(0, 500)}`);

            const ClaudeApiUtils = require('chat-core/ClaudeApiUtils');
            if (ClaudeApiUtils.isContextExceededError(responseText)) {
              if (isFirstCall) {
                // ThreadContinuation recovery — only on first API call
                log('[ClaudeConversation] Context length exceeded - invoking ThreadContinuation');

                const ThreadContinuation = require('chat-core/ThreadContinuation');
                const originalParams = requestContext.params;

                const conversationForContinuation = {
                  id: requestId || `context-exceeded-${Date.now()}`,
                  messages: messages,
                  memory: context.memory || {},
                  inheritedSummary: context.inheritedSummary || null,
                  threadSequence: context.threadSequence || 1
                };

                // Notify sidebar that compaction is starting
                onThinking('*Context limit reached — compacting conversation history. Extracting memory and generating a summary. This may take a moment...*', sequenceId);

                // Handle thread continuation - extracts memory, generates summary, compresses context
                const continuationResult = ThreadContinuation.handleThreadContinuation(
                  conversationForContinuation,
                  originalParams.text  // The user message that triggered the context exceeded
                );

                if (!continuationResult.success) {
                  log(`[ClaudeConversation] ThreadContinuation failed: ${continuationResult.error}`);
                  throw new Error(`Context length exceeded and continuation failed: ${continuationResult.error}`);
                }

                // Notify sidebar that compaction completed
                onThinking('*Compaction complete — retrying with compressed context.*', sequenceId);

                log(`[ClaudeConversation] Continuation created new thread: ${continuationResult.newThread.id}`);

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

                log(`[ClaudeConversation] Retrying with compressed context: ${compressedMessages.length} messages`);

                // Recursive call with compressed messages and updated context
                return this.sendMessage({
                  ...originalParams,
                  messages: compressedMessages,
                  context: {
                    ...context,
                    memory: continuationResult.newThread.memory,
                    inheritedSummary: continuationResult.newThread.inheritedSummary,
                    threadSequence: continuationResult.newThread.threadSequence,
                    threadContinued: true
                  }
                });
              } else {
                throw new Error('Context length exceeded during tool execution. The conversation is too long. Please start a new conversation.');
              }
            }

            throw new Error(`Claude API error (${statusCode}): ${responseText}`);
          }

          let result;
          try {
            result = JSON.parse(responseText);
          } catch (e) {
            throw new Error(`Failed to parse Claude API response: ${e.message} — body: ${responseText.substring(0, 200)}`);
          }

          // Parse response content (helper)
          const { thinkingMessages, contentBlocks, toolUses } = this._parseResponseContent(result.content, onThinking, sequenceId);
          allThinkingMessages.push(...thinkingMessages);

          // Add assistant response to messages
          messages.push({ role: 'assistant', content: result.content });
          this._addAssistantToSnippet(snippet, result.content);

          // No tool uses → done
          if (toolUses.length === 0 || !this._toolRegistry) {
            return {
              success: true,
              response: contentBlocks.join('\n'),
              message: { role: 'assistant', content: result.content },
              messages,
              threadHistorySnippet: snippet,
              usage: result.usage,
              thinkingMessages: allThinkingMessages,
              toolUses,
              stopReason: result.stop_reason,
              sequenceId,
              context
            };
          }

          // Tool execution
          if (isFirstCall) {
            const enabledToolNames = this._toolRegistry.getEnabledToolNames().join(',');
            log(`[REGISTRY] Initialized: tools=${enabledToolNames}`);
            isFirstCall = false;
          }

          const toolResults = this._executeToolCalls(toolUses, context, onThinking, sequenceId);

          // Add tool results to messages and loop
          const toolResultMsg = {
            role: 'user',
            content: toolResults.map(r => ({
              type: 'tool_result',
              tool_use_id: r.tool_use_id,
              content: r.content
            }))
          };
          messages.push(toolResultMsg);
          snippet.push(toolResultMsg);

          // Loop back → next API call with updated messages
        }
      }

      /**
       * Load knowledge via provider (if available)
       * @private
       * @returns {Array|null} Knowledge data as JSON array or null if not available
       */
      _loadKnowledge() {
        if (!this._knowledgeProvider || !this._knowledgeProvider.loadKnowledge) {
          return null;
        }
        if (!this._toolRegistry) {
          log('[ClaudeConversation] Cannot load knowledge: no ToolRegistry');
          return null;
        }
        return this._knowledgeProvider.loadKnowledge(this._toolRegistry);
      }

      /**
       * Load custom system prompt via provider (if available)
       * @private
       * @returns {string|null} Custom prompt or null if not found
       */
      _loadCustomSystemPrompt() {
        // Return cached value if already loaded
        if (this._customSystemPrompt !== undefined) {
          return this._customSystemPrompt;
        }

        if (!this._knowledgeProvider || !this._knowledgeProvider.loadCustomSystemPrompt) {
          this._customSystemPrompt = null;
          return null;
        }

        try {
          this._customSystemPrompt = this._knowledgeProvider.loadCustomSystemPrompt();
          return this._customSystemPrompt;
        } catch (error) {
          log(`[SystemPrompt] Error loading custom prompt: ${error}`);
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
              parts.push(`- ${fact}`);
            });
            parts.push('');
          }

          if (memory.entities && Object.keys(memory.entities).length > 0) {
            parts.push('### Relevant Entities');
            Object.entries(memory.entities).slice(0, 10).forEach(([key, value]) => {
              if (Array.isArray(value)) {
                parts.push(`- ${key}: ${value.slice(0, 5).join(', ')}`);
              } else {
                parts.push(`- ${key}: ${String(value).substring(0, 100)}`);
              }
            });
            parts.push('');
          }
        }

        // Add historical anchors if available (formatted table)
        if (historicalAnchors && historicalAnchors.length > 0) {
          parts.push(this._ChatService.formatHistoricalAnchors(historicalAnchors));
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
          log('[SystemPrompt] Using custom prompt from _SheetsChat tab');
          return customPrompt;
        }

        // Gather environment context at prompt initialization
        // This eliminates the first round-trip where Claude probes for context
        const envContext = this._SystemPrompt.gatherEnvironmentContext();
        log(`[SystemPrompt] Environment context gathered: ${envContext?.type || 'unknown'}`);

        // Fall back to default with environment context
        log('[SystemPrompt] Using default prompt with environment context');
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
      // KNOWLEDGE MANAGEMENT (delegated to knowledgeProvider)
      // =========================================================================

      /**
       * Clear KnowledgeToolHandler cache after modifications
       * @private
       */
      _clearKnowledgeCache() {
        try {
          if (this._toolRegistry && this._toolRegistry._handlers) {
            const knowledgeHandler = this._toolRegistry._handlers.get('knowledge');
            if (knowledgeHandler && typeof knowledgeHandler.clearCache === 'function') {
              knowledgeHandler.clearCache();
              log('[KNOWLEDGE] Cache cleared');
            }
          }
        } catch (e) {
          log(`[KNOWLEDGE] Could not clear cache: ${e.message}`);
        }
      }

      /**
       * Get knowledge management tools from provider
       * Provider supplies tool definitions with execute functions
       * @returns {Array} Array of tool definitions with execute functions
       */
      _getKnowledgeManagementTools() {
        if (!this._knowledgeProvider || !this._knowledgeProvider.getKnowledgeManagementTools) {
          return [];
        }
        return this._knowledgeProvider.getKnowledgeManagementTools(
          () => this._clearKnowledgeCache()
        );
      }
    }

    // Export for CommonJS
    module.exports = ClaudeConversation;
}

__defineModule__(_main);