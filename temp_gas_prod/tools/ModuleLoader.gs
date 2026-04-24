function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ModuleLoader - Utility for executing CommonJS-style module content
   * 
   * Executes tool/test files that use module.exports pattern:
   *   module.exports = { name, description, params, execute, ... }
   * 
   * Provides ctx object with all GAS services and tool wrappers,
   * making them available to module code via closure.
   */

  class ModuleLoader {
    /**
     * Execute module content and return module.exports
     * 
     * @param {string} content - Module source code (must set module.exports)
     * @param {Object|null} ctx - Context object with services (null for metadata extraction)
     * @returns {{success: boolean, exports?: Object, error?: string}}
     * 
     * @example
     * // Extract metadata (ctx = null)
     * const result = ModuleLoader.loadModule(fileContent, null);
     * if (result.success) {
     *   console.log(result.exports.name);        // tool name
     *   console.log(result.exports.description); // description
     *   console.log(result.exports.params);      // param notation
     * }
     * 
     * @example
     * // Execute with full context
     * const ctx = ModuleLoader.buildContext(toolRegistry, context);
     * const result = ModuleLoader.loadModule(fileContent, ctx);
     * if (result.success) {
     *   const output = result.exports.execute(input);
     * }
     */
    static loadModule(content, ctx = null) {
      if (!content || typeof content !== 'string') {
        return { success: false, error: 'Content must be a non-empty string' };
      }

      try {
        // Create module/exports objects
        const module = { exports: {} };
        const exports = module.exports;

        // Build the function with module, exports, and ctx parameters
        // ctx is available via closure inside the module code
        const fn = new Function('module', 'exports', 'ctx', content);

        // Execute - ctx may be null for metadata extraction
        fn(module, exports, ctx);

        // Validate that something was exported
        if (Object.keys(module.exports).length === 0) {
          return { success: false, error: 'Module did not export anything (module.exports is empty)' };
        }

        return { success: true, exports: module.exports };

      } catch (e) {
        return { 
          success: false, 
          error: `Module execution failed: ${e.message}`,
          stack: e.stack
        };
      }
    }

    /**
     * Check if a filename indicates a test file
     * 
     * @param {string} filename - Filename to check
     * @returns {boolean} True if this is a test file
     * 
     * @example
     * isTestFile('usaw_rankings.gs')      // false
     * isTestFile('usaw_rankings.test.gs') // true
     * isTestFile('my_tool.spec.gs')       // true
     */
    static isTestFile(filename) {
      if (!filename || typeof filename !== 'string') return false;
      return /\.(test|spec)\.gs$/i.test(filename);
    }

    /**
     * Extract tool name from filename
     * 
     * @param {string} filename - Filename to parse
     * @returns {string} Tool name (without extension)
     * 
     * @example
     * getToolName('usaw_rankings.gs')      // 'usaw_rankings'
     * getToolName('usaw_rankings.test.gs') // 'usaw_rankings'
     * getToolName('my_tool.spec.gs')       // 'my_tool'
     */
    static getToolName(filename) {
      if (!filename || typeof filename !== 'string') return '';
      
      // Remove .test.gs or .spec.gs suffix first
      let name = filename.replace(/\.(test|spec)\.gs$/i, '');
      
      // Remove plain .gs suffix
      name = name.replace(/\.gs$/i, '');
      
      return name;
    }

    /**
     * Check if content uses module.exports pattern
     * Used to detect module-style vs bare code implementations
     * 
     * @param {string} content - Code content to check
     * @returns {boolean} True if content appears to be a module
     */
    static isModuleStyle(content) {
      if (!content || typeof content !== 'string') return false;
      
      // Look for module.exports = or exports. patterns
      return /module\.exports\s*=/.test(content) || /exports\.\w+\s*=/.test(content);
    }

    /**
     * Build the ctx object for module execution
     * Contains all GAS services, tool wrappers, and helpers
     * 
     * @param {Object} toolRegistry - ToolRegistry instance for calling other tools
     * @param {Object} context - Execution context (toolState, think, depth, callChain)
     * @param {string} currentToolName - Name of the tool being executed (for callChain)
     * @returns {Object} Context object for module execution
     */
    static buildContext(toolRegistry, context = {}, currentToolName = '') {
      const toolState = context.toolState || {};
      
      // Build tool wrappers
      const toolWrappers = {};
      
      if (toolRegistry) {
        const enabledTools = toolRegistry.getEnabledToolNames();
        
        enabledTools.forEach(toolName => {
          // Skip self and exec to prevent recursion
          if (toolName === currentToolName || toolName === 'exec') return;
          
          toolWrappers[toolName] = (toolInput) => {
            const result = toolRegistry.executeToolCall(
              toolName,
              toolInput,
              {
                ...context,
                depth: (context.depth || 0) + 1,
                callChain: [...(context.callChain || [currentToolName]), toolName]
              }
            );
            
            // Throw on failure so module code can handle
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
        });
      }
      
      // thinking() helper - sends progress to UI + logs
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
      
      // log() helper - server-side diagnostics
      const log = (msg) => {
        try {
          const message = msg == null ? '' :
            typeof msg === 'string' ? msg : JSON.stringify(msg);
          Logger.log(message);
        } catch (e) {
          Logger.log('[log error] ' + String(msg));
        }
      };
      
      // Build the full ctx object
      return {
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
        think: thinking,  // Alias
        
        // Tool state (shared across calls in a conversation)
        toolState,
        
        // Tool wrappers (call other tools)
        ...toolWrappers,
        
        // Also expose toolWrappers object for introspection
        tools: toolWrappers,
        
        // Require function for test framework (if available)
        require: (moduleName) => {
          try {
            return globalThis.require ? globalThis.require(moduleName) : null;
          } catch (e) {
            log(`[ctx.require] Failed to load '${moduleName}': ${e.message}`);
            return null;
          }
        }
      };
    }

    /**
     * Extract metadata from module content without executing
     * Uses loadModule with null ctx to get exports
     * 
     * @param {string} content - Module source code
     * @param {string} filename - Source filename (for name derivation)
     * @returns {{success: boolean, metadata?: Object, error?: string}}
     */
    static extractMetadata(content, filename = '') {
      const result = this.loadModule(content, null);
      
      if (!result.success) {
        return result;
      }
      
      const exports = result.exports;
      const derivedName = this.getToolName(filename);
      
      // Build metadata object
      const metadata = {
        name: exports.name || derivedName,
        description: exports.description || '',
        params: exports.params || '',
        returns: exports.returns || '',
        enabled: exports.enabled !== false,  // Default to true
        
        // For tests
        examples: exports.examples || null,
        expects: exports.expects || null,
        
        // The full content is the implementation
        implementation: content
      };
      
      // Validate required fields for tools
      if (!this.isTestFile(filename)) {
        if (!metadata.name) {
          return { success: false, error: 'Tool module must have name property' };
        }
        if (!metadata.description) {
          return { success: false, error: `Tool '${metadata.name}' must have description property` };
        }
        if (typeof exports.execute !== 'function') {
          return { success: false, error: `Tool '${metadata.name}' must have execute function` };
        }
      }
      
      return { success: true, metadata };
    }
  }

  module.exports = ModuleLoader;
}

__defineModule__(_main);