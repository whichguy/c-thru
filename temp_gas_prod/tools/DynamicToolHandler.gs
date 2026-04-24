function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * DynamicToolHandler - Executes user-defined functions from _Tools sheet
   * 
   * Supports two execution modes:
   * 1. Module-style: Tools using module.exports = { execute: function(input) {...} }
   * 2. Bare code (legacy): Direct implementation code with injected variables
   * 
   * Extends ToolBase to provide consistent behavior with built-in tools.
   * Auto-injects all GAS services and helper functions so user code
   * focuses purely on business logic.
   * 
   * Available in user code:
   * - All GAS Services: SpreadsheetApp, DriveApp, UrlFetchApp, etc.
   * - Helpers: input, toolState, thinking(), log()
   * - Tool wrappers: fetch(), knowledge(), askllm(), analyzeUrl()
   * - For modules: ctx object with all of the above
   */

  class DynamicToolHandler extends require('tools/ToolBase') {
    /**
     * @param {Object} config - Tool configuration from _Tools sheet
     * @param {string} config.name - Tool name (snake_case)
     * @param {string} config.description - Tool description for Claude
     * @param {string} config.params - Param notation (e.g., "id!, count = 10")
     * @param {string} config.implementation - ES6 function body or module code
     * @param {string} [config.returns] - Return type hint for Claude
     */
    constructor(config) {
      super(config.name);
      this.config = config;
      this._cachedSchema = null;
    }
    
    /**
     * Returns the Claude API tool definition
     * @returns {Object} Tool definition with name, description, input_schema
     */
    getToolDefinition() {
      const DynamicToolParser = require('tools/DynamicToolParser');
      
      // Cache schema to avoid re-parsing
      if (!this._cachedSchema) {
        this._cachedSchema = DynamicToolParser.parseParams(this.config.params);
      }
      
      // Build description with return type if specified
      let description = this.config.description;
      if (this.config.returns) {
        description += `\n\nReturns: ${this.config.returns}`;
      }
      
      // Create clean schema without internal _defaults property
      const schema = {
        type: this._cachedSchema.type,
        properties: this._cachedSchema.properties
      };
      if (this._cachedSchema.required?.length > 0) {
        schema.required = this._cachedSchema.required;
      }
      
      return {
        name: this.config.name,
        description: description,
        input_schema: schema
      };
    }
    
    /**
     * Check if implementation uses module.exports pattern
     * @returns {boolean} True if module-style
     */
    _isModuleStyle() {
      const impl = this.config.implementation || '';
      return /module\.exports\s*=/.test(impl) || /exports\.\w+\s*=/.test(impl);
    }
    
    /**
     * Execute the user-defined function with full GAS context
     * Routes to module or bare code execution based on implementation style
     * 
     * @param {Object} input - Tool input from Claude
     * @param {Object} context - Execution context (toolState, toolRegistry, think, etc.)
     * @returns {Object} Result object with success, result/error fields
     */
    execute(input, context = {}) {
      const DynamicToolParser = require('tools/DynamicToolParser');
      const toolState = context.toolState || {};
      const toolRegistry = context.toolRegistry;
      
      // Capture original input before transformation for accurate error diagnostics
      const originalInput = input != null ? { ...input } : {};
      
      // Log the implementation code before execution
      this._logImplementation();
      
      try {
        // Normalize null/undefined input to empty object
        if (input == null) {
          input = {};
        }
        
        // Ensure input is a plain object
        if (typeof input !== 'object' || Array.isArray(input)) {
          return this._errorResult(
            `Invalid input for tool '${this.toolName}': expected object, got ${Array.isArray(input) ? 'array' : typeof input}`,
            new Error('Invalid input type')
          );
        }
        
        // Parse schema and apply defaults
        if (!this._cachedSchema) {
          this._cachedSchema = DynamicToolParser.parseParams(this.config.params);
        }
        
        // Apply defaults to input
        input = DynamicToolParser.applyDefaults({ ...input }, this._cachedSchema);
        
        // Validate input
        const validation = DynamicToolParser.validateInput(input, this._cachedSchema);
        if (!validation.valid) {
          return this._errorResult(
            `Invalid input for tool '${this.toolName}': ${validation.errors.join('; ')}`,
            new Error(validation.errors[0])
          );
        }
        
        // Route to appropriate execution mode
        if (this._isModuleStyle()) {
          return this._executeModule(input, context, toolState, toolRegistry);
        } else {
          return this._executeBareCode(input, context, toolState, toolRegistry);
        }
        
      } catch (error) {
        return this._handleExecutionError(error, originalInput, toolState, context);
      }
    }
    
    /**
     * Execute module-style implementation using ModuleLoader
     * @private
     */
    _executeModule(input, context, toolState, toolRegistry) {
      const ModuleLoader = require('tools/ModuleLoader');
      
      Logger.log(`[DynamicToolHandler] Executing module-style tool: ${this.toolName}`);
      
      // Build ctx with all services and tool wrappers
      const ctx = ModuleLoader.buildContext(toolRegistry, context, this.toolName);
      
      // Load and execute the module
      const loadResult = ModuleLoader.loadModule(this.config.implementation, ctx);
      
      if (!loadResult.success) {
        return this._errorResult(
          `Module load failed for '${this.toolName}': ${loadResult.error}`,
          new Error(loadResult.error),
          { phase: 'module_load', stack: loadResult.stack }
        );
      }
      
      const moduleExports = loadResult.exports;
      
      // Validate execute function exists
      if (typeof moduleExports.execute !== 'function') {
        return this._errorResult(
          `Tool '${this.toolName}' module does not export execute function`,
          new Error('Missing execute function'),
          { phase: 'validation', exports: Object.keys(moduleExports) }
        );
      }
      
      // Execute the module's execute function
      const result = moduleExports.execute(input);
      
      // Build success response with metadata
      const metadata = { toolState, executionMode: 'module' };
      
      if (this.config.returns) {
        metadata.resultType = this.config.returns;
      }
      if (Array.isArray(result)) {
        metadata.resultCount = result.length;
      }
      
      // Write to output_range if configured (errors propagate to fail tool execution)
      if (this.config.outputRange && result !== undefined) {
        this._writeToOutputRange(result);
      }
      
      return this._successResult(result, metadata);
    }
    
    /**
     * Execute bare code implementation (legacy mode)
     * @private
     */
    _executeBareCode(input, context, toolState, toolRegistry) {
      Logger.log(`[DynamicToolHandler] Executing bare-code tool: ${this.toolName}`);
      
      // Create wrapper functions for other tools
      let fetch, knowledge, askllm, analyzeUrl, fetchUrls;
      
      // Generic callTool function for calling ANY tool by name
      const callTool = toolRegistry ? (toolName, toolInput) => {
        const result = toolRegistry.executeToolCall(
          toolName,
          toolInput,
          {
            ...context,
            depth: (context.depth || 0) + 1,
            callChain: [...(context.callChain || [this.toolName]), toolName]
          }
        );
        
        if (!result.success) {
          const errorMsg = (result.error || 'Unknown error').substring(0, 500);
          const err = new Error(`Tool '${toolName}' failed: ${errorMsg}`);
          err.nestedError = result;
          if (result.stack) {
            err.stack = err.stack + '\n--- nested tool stack ---\n' + result.stack;
          }
          throw err;
        }
        
        return result.result;
      } : undefined;
      
      if (toolRegistry) {
        const enabledTools = toolRegistry.getEnabledToolNames();
        
        enabledTools.forEach(toolName => {
          // Skip self and exec to prevent recursion
          if (toolName === this.toolName || toolName === 'exec') return;
          
          const wrapperFn = (toolInput) => {
            const result = toolRegistry.executeToolCall(
              toolName,
              toolInput,
              {
                ...context,
                depth: (context.depth || 0) + 1,
                callChain: [...(context.callChain || [this.toolName]), toolName]
              }
            );
            
            // Throw on failure so user code can handle or it propagates as tool error
            if (!result.success) {
              const errorMsg = (result.error || 'Unknown error').substring(0, 500);
              const err = new Error(`Tool '${toolName}' failed: ${errorMsg}`);
              err.nestedError = result;
              if (result.stack) {
                err.stack = err.stack + '\n--- nested tool stack ---\n' + result.stack;
              }
              throw err;
            }
            
            return result.result;
          };
          
          if (toolName === 'fetch') fetch = wrapperFn;
          else if (toolName === 'knowledge') knowledge = wrapperFn;
          else if (toolName === 'askllm') askllm = wrapperFn;
          else if (toolName === 'analyzeUrl') analyzeUrl = wrapperFn;
          else if (toolName === 'fetchUrls') fetchUrls = wrapperFn;
        });
      }
      
      // thinking() - sends progress to UI + logs
      const contextThink = context.think || (() => {});
      const thinking = (msg) => {
        let message;
        try {
          message = typeof msg === 'object' ? JSON.stringify(msg) : `${msg}`;
        } catch (e) {
          message = `[non-serializable: ${e.message}]`;
        }
        Logger.log(`[THINKING] ${message}`);
        contextThink(message);
      };
      
      // log() - server-side diagnostics
      const log = (msg) => {
        try {
          const message = msg == null ? '' :
            typeof msg === 'string' ? msg : JSON.stringify(msg);
          Logger.log(message);
        } catch (e) {
          Logger.log('[log error] ' + String(msg));
        }
      };
      
      // Create real module object for CommonJS compatibility
      // DynamicToolHandler acts as a module loader - must set up proper module context
      // so that require() calls inside the dynamic code have correct save/restore state
      const module = { exports: {} };
      const exports = module.exports;
      
      // Save current module context and establish our fresh module as current
      const previousModule = globalThis.__currentModule;
      globalThis.__currentModule = module;
      
      // Build function with all injected context
      const fn = new Function(
        // Core input
        'input',
        'toolState',
        
        // CommonJS module support
        'module',
        'exports',
        
        // All GAS Services
        'SpreadsheetApp',
        'ScriptApp',
        'UrlFetchApp',
        'DriveApp',
        'GmailApp',
        'DocumentApp',
        'SlidesApp',
        'CalendarApp',
        'FormApp',
        'CacheService',
        'PropertiesService',
        'Utilities',
        'Logger',
        'Session',
        'HtmlService',
        'ContentService',
        'LockService',
        
        // Helper functions
        'thinking',
        'log',
        
        // Tool wrappers
        'fetch',
        'knowledge',
        'askllm',
        'analyzeUrl',
        'fetchUrls',
        
        // Generic tool caller
        'callTool',
        
        // Wrap implementation in IIFE for clean scope
        `return (function() { ${this.config.implementation} })();`
      );
      
      // Execute with all context injected (wrapped in try/finally to restore module context)
      let iifeResult;
      try {
        iifeResult = fn(
        input,
        toolState,
        
        // CommonJS module
        module,
        exports,
        
        // GAS Services
        SpreadsheetApp,
        ScriptApp,
        UrlFetchApp,
        DriveApp,
        GmailApp,
        DocumentApp,
        SlidesApp,
        CalendarApp,
        FormApp,
        CacheService,
        PropertiesService,
        Utilities,
        Logger,
        Session,
        HtmlService,
        ContentService,
        LockService,
        
        // Helpers
        thinking,
        log,
        
        // Tool wrappers (may be undefined if not enabled)
          fetch,
          knowledge,
          askllm,
          analyzeUrl,
          fetchUrls,
          
          // Generic tool caller
          callTool
        );
      } finally {
        // Restore previous module context (critical for subsequent require() calls)
        globalThis.__currentModule = previousModule;
      }
      
      // Determine actual result: prefer explicit return, fall back to module.exports
      let result;
      if (iifeResult !== undefined) {
        result = iifeResult;
      } else if (Object.keys(module.exports).length > 0) {
        // Tool used module.exports for return value
        result = module.exports;
      } else {
        result = undefined;
      }
      
      // Build success response with metadata
      const metadata = { toolState, executionMode: 'bare_code' };
      
      if (this.config.returns) {
        metadata.resultType = this.config.returns;
      }
      if (Array.isArray(result)) {
        metadata.resultCount = result.length;
      }
      
      // Write to output_range if configured (errors propagate to fail tool execution)
      if (this.config.outputRange && result !== undefined) {
        this._writeToOutputRange(result);
      }
      
      return this._successResult(result, metadata);
    }
    
    /**
     * Write result to configured output range
     * @param {*} result - Tool execution result
     * @private
     */
    _writeToOutputRange(result) {
      const outputRange = this.config.outputRange;
      if (!outputRange) return;

      // Require SheetName!Range format
      if (!outputRange.includes('!')) {
        throw new Error(`output_range '${outputRange}' must use SheetName!Range format (e.g., 'Data!A1')`);
      }

      const [sheetName, rangeNotation] = outputRange.split('!');
      if (!sheetName || !rangeNotation) {
        throw new Error(`output_range '${outputRange}' has invalid format - expected 'SheetName!Range'`);
      }

      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        throw new Error(`output_range '${outputRange}' specified but no bound spreadsheet available`);
      }

      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        throw new Error(`output_range sheet '${sheetName}' not found in spreadsheet`);
      }
      
      // Validate range notation before attempting write
      let range;
      try {
        range = sheet.getRange(rangeNotation);
      } catch (e) {
        throw new Error(`output_range '${outputRange}' has invalid range notation: ${e.message}`);
      }

      // Handle result types
      if (Array.isArray(result)) {
        if (Array.isArray(result[0])) {
          // 2D array
          range.offset(0, 0, result.length, result[0].length).setValues(result);
        } else {
          // 1D array -> column
          const columnData = result.map(v => [v]);
          range.offset(0, 0, columnData.length, 1).setValues(columnData);
        }
      } else if (typeof result === 'object' && result !== null) {
        range.setValue(JSON.stringify(result, null, 2));
      } else {
        range.setValue(result);
      }
    }
    
    /**
     * Handle execution errors with full diagnostic context
     * @private
     */
    _handleExecutionError(error, originalInput, toolState, context) {
      // Safe input serialization
      let inputStr;
      try {
        inputStr = JSON.stringify(originalInput);
        if (inputStr.length > 5000) {
          inputStr = inputStr.substring(0, 5000) + '...[truncated from ' + inputStr.length + ' chars]';
        }
      } catch (e) {
        inputStr = '[non-serializable: ' + e.message + ']';
      }
      
      // Implementation context (first 20 lines)
      const implLines = (this.config.implementation || '').split('\n');
      const implSnippet = implLines.length > 20
        ? implLines.slice(0, 20).join('\n') + '\n...[' + (implLines.length - 20) + ' more lines]'
        : this.config.implementation;
      
      // Rich error message
      const errorMessage = [
        `Tool '${this.toolName}' execution failed`,
        `Error: ${error.message}`,
        `Input: ${inputStr}`,
        `Implementation (first 20 lines):\n${implSnippet}`,
        `Full stack:\n${error.stack}`
      ].join('\n');
      
      Logger.log(`[DynamicToolHandler] ${errorMessage}`);
      
      // Extract nested error diagnostics
      const nestedDiagnostics = error.nestedError?.diagnostics;
      
      return this._errorResult(
        `Tool '${this.toolName}' failed: ${error.message}`,
        error,
        {
          phase: 'execution',
          input: originalInput,
          toolState: toolState,
          depth: context.depth,
          callChain: context.callChain,
          implementation: implSnippet,
          nestedError: nestedDiagnostics
        }
      );
    }
    
    /**
     * Log the implementation code before execution
     */
    _logImplementation() {
      const impl = this.config.implementation || '';
      const lines = impl.split('\n');
      const lineCount = lines.length;
      const charCount = impl.length;
      const mode = this._isModuleStyle() ? 'module' : 'bare_code';
      
      Logger.log(`[DYNAMIC_TOOL] ${this.toolName}: ${mode} implementation (${lineCount} lines, ${charCount} chars)`);
      
      if (charCount > 0) {
        Logger.log(`[DYNAMIC_CODE]\n${impl}`);
      }
    }
  }

  module.exports = DynamicToolHandler;
}

__defineModule__(_main);