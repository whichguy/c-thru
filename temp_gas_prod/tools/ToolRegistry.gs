function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ToolRegistry - Manages multiple tools with enable/disable capabilities
   * Central dispatcher for tool definitions and execution
   * Manages in-memory toolState across tool calls in a conversation
   * Automatically stores tool results in toolState.previousResult for chaining
   */

  class ToolRegistry {
    /**
     * @param {Object} config - Configuration object with tool enable flags
     * @param {boolean} config.enableExec - Enable exec tool (default: true)
     * @param {boolean} config.enableSearch - Enable fetch tool (default: true)
     * @param {boolean} config.enableKnowledge - Enable knowledge tool (default: true)
     * @param {boolean} config.enablePrompt - Enable prompt tool (default: true)
     * @param {boolean} config.enableAnalyzeUrl - Enable analyzeUrl tool (default: true)
     * @param {boolean} config.enableFetchUrls - Enable fetchUrls tool (default: true)
     * @param {boolean} config.enableDynamicTools - Enable dynamic tools from _Tools sheet (default: true)
     */
    constructor(config = {}) {
      this.config = {
        enableExec: config.enableExec !== false,  // Default true
        enableSearch: config.enableSearch !== false,  // Default true
        enableKnowledge: config.enableKnowledge !== false,  // Default true
        enablePrompt: config.enablePrompt !== false,  // Default true
        enableAnalyzeUrl: config.enableAnalyzeUrl !== false,  // Default true
        enableFetchUrls: config.enableFetchUrls !== false,  // Default true
        enableDynamicTools: config.enableDynamicTools !== false  // Default true
      };
      
      this.handlers = {};
      this.toolState = {};  // In-memory state scoped to this conversation, shared between tools
      
      // Initialize enabled tool handlers
      const handlerConfig = [
        ['enableExec',       'tools/SpreadsheetToolHandler', 'exec'],
        ['enableSearch',     'tools/SearchToolHandler',      'fetch'],
        ['enableKnowledge',  'tools/KnowledgeToolHandler',   'knowledge'],
        ['enablePrompt',     'tools/PromptToolHandler',      'askllm'],
        ['enableAnalyzeUrl', 'tools/AnalyzeUrlToolHandler',  'analyzeUrl'],
        ['enableFetchUrls',  'tools/FetchUrlsToolHandler',   'fetchUrls'],
      ];
      for (const [flag, mod, key] of handlerConfig) {
        if (this.config[flag]) this.handlers[key] = new (require(mod))();
      }
      
      // Load dynamic tools from _Tools sheet (if enabled and sheet exists)
      if (this.config.enableDynamicTools) {
        try {
          const DynamicToolLoader = require('tools/DynamicToolLoader');
          const dynamicHandlers = DynamicToolLoader.loadHandlers();
          
          // Check for conflicts with built-in tools
          const builtInNames = Object.keys(this.handlers);
          const conflicts = dynamicHandlers.filter(h => builtInNames.includes(h.toolName));
          
          if (conflicts.length > 0) {
            Logger.log(`[ToolRegistry] Warning: ${conflicts.length} dynamic tool(s) conflict with built-in tools: ${conflicts.map(h => h.toolName).join(', ')}`);
            Logger.log(`[ToolRegistry] Conflicting dynamic tools will be skipped`);
          }
          
          // Add non-conflicting handlers
          dynamicHandlers.forEach(handler => {
            if (!builtInNames.includes(handler.toolName)) {
              this.handlers[handler.toolName] = handler;
            }
          });
          
          // Note: DynamicToolLoader already logs FINAL SUMMARY with tool names
          // No need to duplicate that log here
        } catch (e) {
          const errorDetails = [
            `[ToolRegistry] Failed to load dynamic tools`,
            `  Error: ${e.message}`,
            `  Stack: ${(e.stack || '').split('\n').slice(0, 3).join('\n    ')}`,
            `  Hint: Check _Tools sheet exists and has valid format`
          ].join('\n');
          Logger.log(errorDetails);
        }
      }
    }
    
    /**
     * Get tool definitions for all enabled tools
     * @returns {Array<Object>} Array of Claude API tool definitions
     */
    getEnabledTools() {
      return Object.values(this.handlers).map(handler => handler.getToolDefinition());
    }
    
    /**
     * Execute a tool call by dispatching to the appropriate handler
     * Uses the unified .run() method from ToolBase
     * 
     * @param {string} toolName - Name of the tool to execute
     * @param {Object} input - Tool input parameters
     * @param {Object} context - Execution context (depth, maxDepth, clientState, etc.)
     * @returns {Object} Tool execution result
     */
    executeToolCall(toolName, input, context = {}) {
      const handler = this.handlers[toolName];

      // Build call chain for diagnostics
      const callChain = [...(context.callChain || []), toolName];
      const depth = context.depth || 0;
      const maxDepth = context.maxDepth || 3;

      // Safely stringify input early - needed for early return diagnostics
      let inputSummary;
      try {
        inputSummary = JSON.stringify(input).substring(0, 500);
      } catch (e) {
        inputSummary = '[circular or non-serializable]';
      }

      if (!handler) {
        return {
          success: false,
          error: `Tool not enabled: ${toolName}. Available tools: ${Object.keys(this.handlers).join(', ')}`,
          diagnostics: {
            timestamp: new Date().toISOString(),
            tool: toolName,
            phase: 'dispatch',
            depth: depth,
            call_chain: callChain,
            input: inputSummary  // Include input for debugging
          }
        };
      }

      // Enforce recursion depth limit to prevent infinite loops
      if (depth > maxDepth) {
        Logger.log(`[TOOL_CALL_BLOCKED] tool=${toolName} depth=${depth} exceeds maxDepth=${maxDepth} chain=${callChain.join(' -> ')}`);
        return {
          success: false,
          error: `Maximum tool call depth (${maxDepth}) exceeded. Possible infinite recursion detected.`,
          depth: depth,
          maxDepth: maxDepth,
          diagnostics: {
            timestamp: new Date().toISOString(),
            tool: toolName,
            phase: 'depth_check',
            depth: depth,
            call_chain: callChain,
            error_type: 'RecursionLimitError',
            input: inputSummary  // Include input for consistency
          }
        };
      }

      // Log before execution with call signature
      const startTime = new Date().getTime();
      // inputSummary already computed above for early return diagnostics
      Logger.log(`[TOOL_CALL_START] tool=${toolName} depth=${depth}/${maxDepth} chain=${callChain.join(' -> ')} input=${inputSummary}`);
      
      try {
        // Merge toolState into context with call chain
        const executionContext = {
          ...context,
          toolState: context.toolState || this.toolState,
          toolRegistry: this,  // Pass registry reference for tool invocation
          depth: depth,
          maxDepth: maxDepth,
          callChain: callChain,  // Pass call chain for error diagnostics
          phase: context.phase || 'execution'
        };
        
        // All tools now use the unified .run() method from ToolBase
        const result = handler.run(input, executionContext);
        
        // Log after execution with timing summary
        const duration = new Date().getTime() - startTime;
        const status = result.success ? 'SUCCESS' : 'ERROR';
        const resultSummary = result.success 
          ? (Array.isArray(result.result) ? `array[${result.result.length}]` : typeof result.result)
          : result.error?.substring(0, 100);
        Logger.log(`[TOOL_CALL_END] tool=${toolName} status=${status} duration=${duration}ms result=${resultSummary}`);
        
        // AUTOMATIC CHAINING: Store successful results in toolState.previousResult
        // This enables natural tool chaining (fetch → exec, etc.)
        if (result.success && result.result !== undefined) {
          executionContext.toolState.previousResult = result.result;
          this.toolState.previousResult = result.result;
        }
        
        // Update toolState if returned in metadata
        if (result.toolState) {
          this.toolState = result.toolState;
        }
        
        return result;
      } catch (error) {
        // Comprehensive error logging with full context
        const duration = new Date().getTime() - startTime;
        
        // Safe stringify for error context
        let inputStr;
        try {
          inputStr = JSON.stringify(input);
          if (inputStr.length > 2000) {
            inputStr = inputStr.substring(0, 2000) + '...[truncated]';
          }
        } catch (e) {
          inputStr = '[non-serializable: ' + e.message + ']';
        }
        
        Logger.log(`[TOOL_CALL_ERROR] tool=${toolName} duration=${duration}ms`);
        Logger.log(`  Call chain: ${callChain.join(' -> ')}`);
        Logger.log(`  Input: ${inputStr}`);
        Logger.log(`  Error: ${error.message}`);
        Logger.log(`  Stack:\n${error.stack}`);
        
        return {
          success: false,
          error: error.toString(),
          message: error.message,
          stack: (error.stack || '').length > 10000
            ? error.stack.substring(0, 10000) + '\n...[truncated]'
            : error.stack,
          toolName: toolName,
          diagnostics: {
            timestamp: new Date().toISOString(),
            duration_ms: duration,
            tool: toolName,
            phase: 'execution',
            depth: depth,
            call_chain: callChain,
            input: inputStr,  // Use stringified version to avoid circular refs
            error_type: error.name || 'Error',
            stack_lines: (error.stack || '').split('\n').length,
            stack_truncated: (error.stack || '').length > 10000
          }
        };
      }
    }
    
    /**
     * Check if a specific tool is enabled
     * @param {string} toolName - Name of the tool to check
     * @returns {boolean} True if tool is enabled
     */
    isToolEnabled(toolName) {
      return Object.prototype.hasOwnProperty.call(this.handlers, toolName);
    }
    
    /**
     * Get list of enabled tool names
     * @returns {Array<string>} Array of enabled tool names
     */
    getEnabledToolNames() {
      return Object.keys(this.handlers);
    }
    
    /**
     * Get current toolState (for debugging)
     * @returns {Object} Current in-memory toolState
     */
    getToolState() {
      return this.toolState;
    }
    
    /**
     * Reset toolState (for testing or starting new context)
     */
    resetToolState() {
      this.toolState = {};
    }
  }

  module.exports = ToolRegistry;
}

__defineModule__(_main);