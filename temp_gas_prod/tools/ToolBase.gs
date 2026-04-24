function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ToolBase - Abstract base class for all tool handlers
   * Provides common functionality to reduce boilerplate and ensure consistency
   */

  class ToolBase {
    /**
     * Constructor
     * @param {string} toolName - Name of the tool
     */
    constructor(toolName) {
      this.toolName = toolName;
      this.executionCount = 0;
      this.lastExecutionTime = null;
    }
    
    /**
     * ABSTRACT: Get the Claude API tool definition
     * Subclasses MUST override this method
     * @returns {Object} Tool definition with name, description, input_schema
     */
    getToolDefinition() {
      throw new Error(`${this.toolName}: getToolDefinition() must be overridden`);
    }
    
    /**
     * ABSTRACT: Execute the tool logic
     * Subclasses MUST override this method
     * @param {Object} input - Tool input from Claude API
     * @param {Object} context - Execution context with:
     *   - think: function(message) - Emit both log and thinking message (recommended)
     *   - onThinking: function(message, sequenceId) - Legacy direct access
     *   - sequenceId: string - Message sequence ID (legacy)
     *   - depth: number - Recursion depth
     *   - maxDepth: number - Maximum recursion depth
     *   - toolsEnabled: Array<string> - Available tools at this depth
     *   - toolState: Object - Tool-specific state passed between calls
     * @returns {Object} Result object with success, result/error fields
     */
    execute(input, context = {}) {
      throw new Error(`${this.toolName}: execute() must be overridden`);
    }
    
    /**
     * Main entry point - handles logging, validation, error wrapping
     * This is called by ToolRegistry.executeTool()
     * @param {Object} input - Tool input from Claude API
     * @param {Object} context - Execution context
     * @returns {Object} Standardized result object
     */
    run(input, context = {}) {
      this.executionCount++;
      const startTime = new Date().getTime();
      
      try {
        // Log tool start
        this._logStart(input, context);
        
        // Validate input against schema
        const validation = this._validateInput(input);
        if (!validation.valid) {
          return this._errorResult(validation.error, new Error(validation.error), { phase: 'validation', input });
        }
        
        // Execute the tool-specific logic
        const result = this.execute(input, context);
        
        // Log tool end with duration
        const duration = new Date().getTime() - startTime;
        this.lastExecutionTime = duration;
        this._logEnd(result, duration);
        
        // Ensure result has success field
        return this._ensureSuccessField(result);
        
      } catch (error) {
        // Log error with duration
        const duration = new Date().getTime() - startTime;
        this._logError(error, duration, context);
        return this._errorResult(error.toString(), error, { ...context, input });
      }
    }
    
    /**
     * Validate input against tool's input schema
     * @param {Object} input - Tool input to validate
     * @returns {Object} {valid: boolean, error?: string}
     */
    _validateInput(input) {
      try {
        const definition = this.getToolDefinition();
        const schema = definition.input_schema;
        
        if (!schema || !schema.required) {
          return { valid: true };
        }
        
        // Check required fields
        for (const field of schema.required) {
          if (input[field] === undefined || input[field] === null) {
            return {
              valid: false,
              error: `Missing required field: ${field}`
            };
          }
        }
        
        return { valid: true };
        
      } catch (error) {
        // Fail closed: validation errors prevent execution
        Logger.log(`[TOOL_VALIDATE] ${this.toolName}: Validation error: ${error.message}`);
        return { valid: false, error: `Schema validation error: ${error.message}` };
      }
    }
    
    /**
     * Create a standardized success result
     * @param {*} result - The result data to return
     * @param {Object} metadata - Optional additional metadata
     * @returns {Object} Success result object
     */
    _successResult(result, metadata = {}) {
      return {
        success: true,
        result: result,
        toolName: this.toolName,
        ...metadata
      };
    }
    
    /**
     * Create a standardized error result with comprehensive diagnostics
     * @param {string} message - Error message
     * @param {Error} error - Optional Error object
     * @param {Object} context - Optional context for diagnostics
     * @returns {Object} Error result object with diagnostics block
     */
    _errorResult(message, error = null, context = {}) {
      const diagnostics = {
        timestamp: new Date().toISOString(),
        tool: this.toolName,
        phase: context.phase || 'unknown',
        depth: context.depth || 0,
        call_chain: context.callChain || [this.toolName],
        error_type: error?.name || 'Error',
        error_message: error?.message || message,
        stack: this._safeStack(error, 10000),
        stack_lines: (error?.stack || '').split('\n').length,
        stack_truncated: (error?.stack || '').length > 10000
      };

      // Capture input if provided (max 5KB)
      if (context.input !== undefined) {
        const inputStr = this._safeStringify(context.input);
        diagnostics.input = inputStr.length > 5000
          ? inputStr.substring(0, 5000) + '...[truncated]'
          : inputStr;  // Always string type for consistency
        diagnostics.input_truncated = inputStr.length > 5000;
      }

      // Capture toolState if provided (max 2KB)
      if (context.toolState !== undefined) {
        const stateStr = this._safeStringify(context.toolState);
        diagnostics.toolState = stateStr.length > 2000
          ? stateStr.substring(0, 2000) + '...[truncated]'
          : stateStr;  // Always string type for consistency
        diagnostics.toolState_truncated = stateStr.length > 2000;
      }

      // Capture implementation snippet for dynamic tools (max 3KB)
      if (context.implementation !== undefined) {
        diagnostics.implementation_snippet = context.implementation.length > 3000
          ? context.implementation.substring(0, 3000) + '...[truncated]'
          : context.implementation;
      }

      // Include nested error diagnostics (from tool wrapper failures in DynamicToolHandler)
      // Must sanitize to prevent circular references from breaking entire diagnostics serialization
      if (context.nestedError !== undefined) {
        try {
          // Verify serializable and limit size to 2KB
          const nestedStr = JSON.stringify(context.nestedError);
          if (nestedStr.length > 2000) {
            diagnostics.nested_error = nestedStr.substring(0, 2000) + '...[truncated]';
            diagnostics.nested_error_truncated = true;
          } else {
            diagnostics.nested_error = context.nestedError;
          }
        } catch (e) {
          diagnostics.nested_error = {
            serialization_failed: true,
            reason: e.message,
            available_keys: Object.keys(context.nestedError || {}).slice(0, 10)
          };
        }
      }

      return {
        success: false,
        error: message,
        message: error?.message,
        stack: diagnostics.stack,
        name: error?.name,
        toolName: this.toolName,
        diagnostics: diagnostics
      };
    }
    
    /**
     * Check recursion depth and throw if exceeded
     * @param {Object} context - Execution context with depth, maxDepth
     * @returns {Object} {depth, maxDepth}
     * @throws {Error} If max depth exceeded
     */
    _checkRecursionDepth(context) {
      const depth = context.depth || 0;
      const maxDepth = context.maxDepth || 3;
      
      if (depth >= maxDepth) {
        throw new Error(`Max recursion depth exceeded (${maxDepth}). Current depth: ${depth}`);
      }
      
      return { depth, maxDepth };
    }
    
    /**
     * Get available tools for the current recursion depth
     * @param {Object} context - Execution context
     * @returns {Array<string>} Array of tool names available at this depth
     */
    _getAvailableTools(context) {
      const depth = context.depth || 0;
      
      // Depth 0 (top level): All tools available
      if (depth === 0) {
        return ['exec', 'fetch', 'knowledge', 'askllm', 'analyzeUrl'];
      }
      
      // Depth 1 (first nesting): No prompt or analyzeUrl (prevent deep nesting)
      if (depth === 1) {
        return ['exec', 'fetch', 'knowledge'];
      }
      
      // Depth 2+ (deep nesting): Only basic tools
      return ['exec', 'fetch'];
    }
    
    /**
     * Ensure result object has success field
     * @param {Object} result - Result from execute()
     * @returns {Object} Result with success field
     */
    _ensureSuccessField(result) {
      if (result.success === undefined) {
        // If no success field, assume success if we got this far
        return {
          success: true,
          result: result,
          toolName: this.toolName
        };
      }
      return result;
    }
    
    /**
     * Log tool start with special formatting for exec tool JavaScript code
     * @param {Object} input - Tool input
     * @param {Object} context - Execution context
     */
    _logStart(input, context) {
      const depth = context.depth || 0;
      const depthStr = depth > 0 ? ` depth=${depth}` : '';
      
      // Special formatting for exec tool with jsCode
      if (this.toolName === 'exec' && input.jsCode) {
        // Type safety: ensure jsCode is a string
        if (typeof input.jsCode !== 'string') {
          Logger.log(`[TOOL_START] tool=${this.toolName}${depthStr ? ' ' + depthStr : ''} jsCode=(invalid type: ${typeof input.jsCode})`);
          return;
        }
        
        // Normalize line endings (Windows CRLF → Unix LF, old Mac CR → LF)
        const normalizedCode = input.jsCode.replace(/\r\n|\r/g, '\n');
        const codeLines = normalizedCode.split('\n');
        const lineCount = codeLines.length;
        const charCount = normalizedCode.length;
        
        // Always log summary header
        Logger.log(`[TOOL_START] tool=${this.toolName}${depthStr ? ' ' + depthStr : ''} jsCode=(${lineCount} lines, ${charCount} chars)`);
        
        // Handle edge case: empty or whitespace-only code
        if (charCount === 0 || (lineCount === 1 && !codeLines[0].trim())) {
          Logger.log('(empty or whitespace-only code)');
          return;
        }
        
        // Always show full code without line numbers (cleaner output)
        Logger.log(`[EXEC_CODE]\n${codeLines.join('\n')}`);
        
      } else {
        // Standard logging for non-exec tools (unchanged)
        const inputJson = JSON.stringify(input);
        Logger.log(`[TOOL_START] tool=${this.toolName}${depthStr ? ' ' + depthStr : ''} input=${inputJson}`);
      }
    }
    
    /**
     * Log tool end with result summary
     * @param {Object} result - Tool result
     * @param {number} duration - Execution duration in ms
     */
    _logEnd(result, duration) {
      // Check for explicit failure OR error property in result (catches user code returning errors)
      const hasError = result.success === false || result.error;
      const status = hasError ? 'ERROR' : 'SUCCESS';
      if (!hasError) {
        Logger.log(`[TOOL_END] ${this.toolName}: ${status} (${duration}ms)`);
      } else {
        const parts = [`[TOOL_END] ${this.toolName}: ${status} (${duration}ms)`];
        if (result.error) parts.push(`error=${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`);
        if (result.message && result.message !== result.error) parts.push(`message=${result.message}`);
        if (result.stack) parts.push(`stack=${result.stack.split('\n')[0]}`);
        Logger.log(parts.join(' | '));
      }
    }
    
    /**
     * Log tool error with full context
     * @param {Error} error - Error object
     * @param {number} duration - Execution duration in ms
     * @param {Object} context - Optional execution context
     */
    _logError(error, duration, context = {}) {
      const lines = [
        `[TOOL_ERROR] ${this.toolName}: FAILED after ${duration}ms`,
        `  Type: ${error.name || 'Error'}`,
        `  Message: ${error.message}`,
        `  Phase: ${context.phase || 'unknown'}`,
        `  Depth: ${context.depth || 0}`
      ];

      if (context.input) {
        lines.push(`  Input: ${this._safeStringify(context.input, 1000)}`);
      }

      if (error.stack) {
        lines.push(`  Stack:\n${error.stack}`);
      }

      Logger.log(lines.join('\n'));
    }
    
    /**
     * Safely stringify an object, handling circular references and large objects
     * @param {*} obj - Object to stringify
     * @param {number} maxLen - Maximum string length (default 10000)
     * @returns {string} JSON string or error message
     */
    _safeStringify(obj, maxLen = 10000) {
      try {
        const str = JSON.stringify(obj);
        return str.length > maxLen ? str.substring(0, maxLen) + '...[truncated]' : str;
      } catch (e) {
        return `[non-serializable: ${e.message}]`;
      }
    }
    
    /**
     * Safely extract stack trace with length limit
     * @param {Error} error - Error object
     * @param {number} maxLen - Maximum stack length (default 10000)
     * @returns {string|null} Stack trace or null
     */
    _safeStack(error, maxLen = 10000) {
      if (!error?.stack) return null;
      const stack = error.stack;
      return stack.length > maxLen ? stack.substring(0, maxLen) + '\n...[truncated]' : stack;
    }
  }

  module.exports = ToolBase;
}

__defineModule__(_main);