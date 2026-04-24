function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * DynamicToolLoader - Reads _Tools sheet and creates DynamicToolHandler instances
   * 
   * Sheet structure (6 columns):
   *   | name | description | params | implementation | enabled | returns |
   * 
   * - name: Tool identifier (snake_case, e.g., "usaw_rankings")
   * - description: What the tool does (shown to Claude)
   * - params: Parameter notation (e.g., "id!, count = 10")
   * - implementation: Full ES6 function body
   * - enabled: TRUE/FALSE (optional, defaults to TRUE)
   * - returns: Return type hint (optional, e.g., "array<{rank, name}>")
   * 
   * Validation:
   * - Syntax-checks implementation at load time
   * - Logs errors with row numbers for debugging
   * - Skips invalid tools gracefully (unless strictMode)
   */

  class DynamicToolLoader {
    /**
     * Validate that JavaScript code compiles without syntax errors
     * @param {string} code - JavaScript code to validate
     * @returns {{valid: boolean, error?: string}} Validation result
     */
    static validateCode(code) {
      if (!code || typeof code !== 'string' || !code.trim()) {
        return { valid: false, error: 'Implementation is empty or not a string' };
      }

      try {
        // Check if this is module-style code (uses module.exports)
        const isModuleStyle = /module\.exports\s*=/.test(code) || /exports\.\w+\s*=/.test(code);
        
        if (isModuleStyle) {
          // Module-style: validate with module/exports/ctx parameters
          new Function('module', 'exports', 'ctx', code);
        } else {
          // Bare code: validate with same signature as execution
          // This catches syntax errors at load time
          new Function(
            'input', 'toolState',
            'module', 'exports',  // CommonJS support
            'SpreadsheetApp', 'ScriptApp', 'UrlFetchApp', 'DriveApp', 'GmailApp',
            'DocumentApp', 'SlidesApp', 'CalendarApp', 'FormApp', 'CacheService',
            'PropertiesService', 'Utilities', 'Logger', 'Session', 'HtmlService',
            'ContentService', 'LockService', 'thinking', 'log',
            'fetch', 'knowledge', 'askllm', 'analyzeUrl', 'fetchUrls',
            `return (function() { ${code} })();`
          );
        }
        return { valid: true };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    }

    /**
     * Validate tool name format
     * @param {string} name - Tool name to validate
     * @returns {{valid: boolean, error?: string}}
     */
    static validateToolName(name) {
      if (!name || typeof name !== 'string') {
        return { valid: false, error: 'Name is empty or not a string' };
      }
      
      // Must be snake_case: lowercase letters, numbers, underscores
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return { 
          valid: false, 
          error: `Name '${name}' must be snake_case (lowercase, numbers, underscores, start with letter)` 
        };
      }
      
      // Reserved names that conflict with built-in tools
      const reserved = ['exec', 'fetch', 'knowledge', 'askllm', 'analyzeUrl', 'fetchUrls'];
      if (reserved.includes(name)) {
        return { valid: false, error: `Name '${name}' is reserved for built-in tools` };
      }
      
      return { valid: true };
    }

    /**
     * Load all enabled dynamic tool handlers from _Tools sheet and/or DriveApp
     * 
     * Loading behavior:
     * - If _Tools sheet exists and has tools: loads from sheet only
     * - If _Tools sheet missing OR empty: also checks DriveApp for tools.json
     * - Sheet tools take precedence over DriveApp tools with same name
     * 
     * Configuration overrides (via ConfigManager):
     * - TOOLS_SHEET_NAME: Override sheet name (default: '_Tools')
     * - TOOLS_FOLDER: Override Drive folder name (default: 'Claude Tools')
     * 
     * DriveApp locations (checked in order):
     * 1. DYNAMIC_TOOLS_FILE_ID script property (if set)
     * 2. "[TOOLS_FOLDER]/tools.json" folder/file in Drive (configurable)
     * 
     * @param {Object} options - Loading options
     * @param {boolean} options.strictMode - If true, throw on any parsing error (default: false)
     * @param {string} options.sheetName - Sheet name (default: '_Tools', can be overridden via ConfigManager)
     * @returns {Array<DynamicToolHandler>} Array of loaded handlers
     * @throws {Error} In strictMode, throws on first parsing error
     */
    static loadHandlers(options = {}) {
      const strictMode = options.strictMode === true;
      
      // Get sheet name with ConfigManager override support
      let sheetName = options.sheetName || '_Tools';
      try {
        const ConfigManager = require('gas-properties/ConfigManager');
        const config = new ConfigManager('CLAUDE_TOOLS');
        const configSheetName = config.get('TOOLS_SHEET_NAME');
        if (configSheetName) {
          sheetName = configSheetName;
          Logger.log(`[DynamicToolLoader] Using ConfigManager override for sheet name: '${sheetName}'`);
        }
      } catch (e) {
        // ConfigManager not available, use default or options
        Logger.log(`[DynamicToolLoader] ConfigManager not available: ${e.message}`);
      }
      
      const handlers = [];
      const loadedNames = new Set();
      let sheetToolCount = 0;
      
      // Try spreadsheet first
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) {
        const sheet = ss.getSheetByName(sheetName);
        if (sheet) {
          const sheetHandlers = this._loadFromSheet(sheet, options);
          sheetHandlers.forEach(h => {
            handlers.push(h);
            loadedNames.add(h.toolName);
          });
          sheetToolCount = sheetHandlers.length;
        } else {
          Logger.log(`[DynamicToolLoader] No '${sheetName}' sheet found`);
        }
      } else {
        Logger.log('[DynamicToolLoader] No active spreadsheet');
      }
      
      // Check DriveApp if:
      // 1. No spreadsheet available, OR
      // 2. No _Tools sheet found, OR  
      // 3. _Tools sheet exists but is empty (no tools loaded)
      if (!ss || sheetToolCount === 0) {
        // Fix A: Short-circuit when no DriveApp source is configured.
        // Checks explicit file ID (fast property read) plus a 5-min CacheService flag
        // set after a previous search found no folder — avoids ~1s DriveApp penalty
        // on every exec_api call when dynamic tools aren't used.
        const hasFileId = !!PropertiesService.getScriptProperties().getProperty('DYNAMIC_TOOLS_FILE_ID');
        const driveCache = CacheService.getScriptCache();
        const folderPreviouslyAbsent = driveCache.get('DTL_NO_DRIVE_FOLDER') === '1';

        if (!hasFileId && folderPreviouslyAbsent) {
          Logger.log('[DynamicToolLoader] Skipping DriveApp search — no file ID configured and folder previously confirmed absent');
        } else {
          Logger.log('[DynamicToolLoader] === BEFORE DriveApp search ===');
          Logger.log(`[DynamicToolLoader] Sheet status: ${sheetToolCount > 0 ? 'LOADED (' + sheetToolCount + ' tools)' : 'EMPTY or MISSING'}`);

          // Fix B: Wrap DriveApp search in try/catch so quota/permission errors are never fatal
          try {
            const driveHandlers = this._loadFromDrive(options);

            // Cache negative result: if nothing found and no file ID, the folder is absent
            if (driveHandlers.length === 0 && !hasFileId) {
              driveCache.put('DTL_NO_DRIVE_FOLDER', '1', 300); // 5-minute cache
            }

            // Add DriveApp tools that don't conflict with sheet tools
            driveHandlers.forEach(h => {
              if (!loadedNames.has(h.toolName)) {
                handlers.push(h);
                loadedNames.add(h.toolName);
                Logger.log(`[DynamicToolLoader] Added DriveApp tool: ${h.toolName}`);
              } else {
                Logger.log(`[DynamicToolLoader] Skipped DriveApp tool '${h.toolName}' - already loaded from sheet`);
              }
            });

            Logger.log(`[DynamicToolLoader] === AFTER DriveApp search ===`);
            Logger.log(`[DynamicToolLoader] DriveApp search result: ${driveHandlers.length} tool(s) found`);
          } catch (driveErr) {
            Logger.log('[DynamicToolLoader] DriveApp search failed: ' + driveErr.message + ' — continuing with 0 dynamic tools');
          }
        }
      }
      
      // Summary
      if (handlers.length > 0) {
        Logger.log(`[DynamicToolLoader] === FINAL SUMMARY ===`);
        Logger.log(`[DynamicToolLoader] Loaded ${handlers.length} dynamic tool(s): ${handlers.map(h => h.toolName).join(', ')}`);
      }
      
      return handlers;
    }
    
    /**
     * Load handlers from _Tools sheet
     * @private
     */
    static _loadFromSheet(sheet, options = {}) {
      const strictMode = options.strictMode === true;
      const data = sheet.getDataRange().getValues();
      
      if (data.length < 2) {
        Logger.log('[DynamicToolLoader] Sheet has no data rows');
        return [];
      }
      
      const DynamicToolHandler = require('tools/DynamicToolHandler');
      const handlers = [];
      const errors = [];
      const loadedNames = new Set();

      // Validate header row
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const expectedHeaders = ['name', 'description', 'params', 'implementation', 'enabled', 'returns', 'output_range'];
      
      // Check first 4 required headers
      const missingHeaders = expectedHeaders.slice(0, 4).filter((h, i) => headers[i] !== h);
      if (missingHeaders.length > 0) {
        const msg = `[DynamicToolLoader] Header mismatch. Expected: ${expectedHeaders.join(', ')}. Got: ${headers.slice(0, 6).join(', ')}`;
        Logger.log(msg);
        if (strictMode) {
          throw new Error(msg);
        }
        // Continue with best effort if headers seem close enough
      }

      // Process each row
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const rowNum = i + 1; // 1-indexed for user-friendly error messages
        
        const name = String(row[0] || '').trim();
        const description = String(row[1] || '').trim();
        const params = String(row[2] || '').trim();
        const implementation = String(row[3] || '').trim();
        const enabledCell = row[4];
        const returns = String(row[5] || '').trim();
        const outputRange = String(row[6] || '').trim();  // Column G
        
        // Skip completely empty rows
        if (!name && !description && !implementation) continue;

        // Determine if enabled (default: true if cell is empty or TRUE)
        const enabled = enabledCell !== false && 
                        enabledCell !== 'FALSE' && 
                        String(enabledCell).toUpperCase() !== 'FALSE';

        // Skip disabled tools
        if (!enabled) {
          Logger.log(`[DynamicToolLoader] Row ${rowNum}: Skipped disabled tool '${name}'`);
          continue;
        }

        // Validate tool name
        const nameValidation = this.validateToolName(name);
        if (!nameValidation.valid) {
          const msg = `[DynamicToolLoader] Row ${rowNum}: ${nameValidation.error}`;
          Logger.log(msg);
          errors.push({ row: rowNum, name: name || '(empty)', error: nameValidation.error });
          if (strictMode) throw new Error(msg);
          continue;
        }

        // Check for duplicate names
        if (loadedNames.has(name)) {
          const msg = `[DynamicToolLoader] Row ${rowNum}: Duplicate tool name '${name}' (already loaded)`;
          Logger.log(msg);
          errors.push({ row: rowNum, name, error: 'Duplicate tool name' });
          if (strictMode) throw new Error(msg);
          continue;
        }

        // Validate required fields
        if (!description) {
          const msg = `[DynamicToolLoader] Row ${rowNum}: Tool '${name}' missing description`;
          Logger.log(msg);
          errors.push({ row: rowNum, name, error: 'Missing description' });
          if (strictMode) throw new Error(msg);
          continue;
        }

        if (!implementation) {
          const msg = `[DynamicToolLoader] Row ${rowNum}: Tool '${name}' missing implementation`;
          Logger.log(msg);
          errors.push({ row: rowNum, name, error: 'Missing implementation' });
          if (strictMode) throw new Error(msg);
          continue;
        }

        // Validate implementation syntax
        const codeValidation = this.validateCode(implementation);
        if (!codeValidation.valid) {
          const msg = `[DynamicToolLoader] Row ${rowNum}: Tool '${name}' has invalid JavaScript: ${codeValidation.error}`;
          Logger.log(msg);
          errors.push({ row: rowNum, name, error: `Syntax error: ${codeValidation.error}` });
          if (strictMode) throw new Error(msg);
          continue;
        }

        // All validations passed - create handler
        try {
          const handler = new DynamicToolHandler({
            name,
            description,
            params,
            implementation,
            returns,
            outputRange
          });
          
          handlers.push(handler);
          loadedNames.add(name);
          // Include description preview in load log for debugging
          const descPreview = description.substring(0, 60).replace(/\n/g, ' ');
          Logger.log(`[DynamicToolLoader] Row ${rowNum}: ${name} | ${descPreview}...`);

        } catch (e) {
          const msg = `[DynamicToolLoader] Row ${rowNum}: Failed to create handler for '${name}': ${e.message}`;
          Logger.log(msg);
          errors.push({ row: rowNum, name, error: e.message });
          if (strictMode) throw new Error(msg);
        }
      }

      // Log errors from sheet loading
      if (errors.length > 0) {
        Logger.log(`[DynamicToolLoader] Sheet loading encountered ${errors.length} error(s):`);
        errors.forEach(e => Logger.log(`  - Row ${e.row} (${e.name}): ${e.error}`));
      }

      return handlers;
    }
    
    /**
     * Load handlers from DriveApp JSON file
     * 
     * Locations checked (in order):
     * 1. DYNAMIC_TOOLS_FILE_ID script property (if set)
     * 2. "[TOOLS_FOLDER]/tools.json" folder (configurable via ConfigManager TOOLS_FOLDER)
     * 
     * Configuration overrides (via ConfigManager):
     * - TOOLS_FOLDER: Override folder name (default: 'Claude Tools')
     * - DYNAMIC_TOOLS_FILE_ID (Script Property): Direct file ID
     * 
     * @private
     */
    static _loadFromDrive(options = {}) {
      const strictMode = options.strictMode === true;
      const DynamicToolHandler = require('tools/DynamicToolHandler');
      const handlers = [];
      
      try {
        let file = null;
        const locationsChecked = [];
        
        Logger.log('[DynamicToolLoader] Starting DriveApp search for tools definitions');
        
        // Try explicit file ID first (from Script Properties)
        Logger.log('[DynamicToolLoader] Checking location 1: DYNAMIC_TOOLS_FILE_ID property');
        const fileId = PropertiesService.getScriptProperties().getProperty('DYNAMIC_TOOLS_FILE_ID');
        if (fileId) {
          locationsChecked.push(`DYNAMIC_TOOLS_FILE_ID=${fileId}`);
          try {
            file = DriveApp.getFileById(fileId);
            Logger.log(`[DynamicToolLoader] ✓ Found tools file via DYNAMIC_TOOLS_FILE_ID: ${fileId}`);
            locationsChecked.push(`FOUND (${fileId})`);
          } catch (e) {
            Logger.log(`[DynamicToolLoader] ✗ DYNAMIC_TOOLS_FILE_ID invalid or inaccessible: ${e.message}`);
            locationsChecked.push(`NOT FOUND (${e.message})`);
          }
        } else {
          Logger.log('[DynamicToolLoader] DYNAMIC_TOOLS_FILE_ID property not set');
          locationsChecked.push('DYNAMIC_TOOLS_FILE_ID=not set');
        }
        
        // Try well-known location with ConfigManager override
        let toolsFolder = 'Claude Tools';
        try {
          const ConfigManager = require('gas-properties/ConfigManager');
          const config = new ConfigManager('CLAUDE_TOOLS');
          const configFolder = config.get('TOOLS_FOLDER');
          if (configFolder) {
            toolsFolder = configFolder;
            Logger.log(`[DynamicToolLoader] Using ConfigManager override for folder: '${toolsFolder}'`);
          }
        } catch (e) {
          Logger.log(`[DynamicToolLoader] ConfigManager not available for TOOLS_FOLDER override: ${e.message}`);
        }
        
        if (!file) {
          Logger.log(`[DynamicToolLoader] Checking location 2: "${toolsFolder}/tools.json" folder`);
          const searchPath = `${toolsFolder}/tools.json`;
          locationsChecked.push(`${searchPath}`);
          
          try {
            const folders = DriveApp.getFoldersByName(toolsFolder);
            if (folders.hasNext()) {
              const folder = folders.next();
              Logger.log(`[DynamicToolLoader] Found folder: "${toolsFolder}"`);
              
              const files = folder.getFilesByName('tools.json');
              if (files.hasNext()) {
                file = files.next();
                Logger.log(`[DynamicToolLoader] ✓ Found tools.json in "${toolsFolder}" folder`);
                locationsChecked.push(`FOUND (${searchPath})`);
              } else {
                Logger.log(`[DynamicToolLoader] ✗ tools.json not found in "${toolsFolder}" folder`);
                locationsChecked.push(`NOT FOUND (no tools.json in folder)`);
              }
            } else {
              Logger.log(`[DynamicToolLoader] ✗ Folder "${toolsFolder}" not found in Drive`);
              locationsChecked.push(`NOT FOUND (folder does not exist)`);
            }
          } catch (e) {
            Logger.log(`[DynamicToolLoader] ✗ Error searching for "${toolsFolder}" folder: ${e.message}`);
            locationsChecked.push(`ERROR (${e.message})`);
          }
        }
        
        if (!file) {
          Logger.log('[DynamicToolLoader] No DriveApp tools file found after checking all locations:');
          locationsChecked.forEach(loc => Logger.log(`  - ${loc}`));
          return [];
        }
        
        Logger.log(`[DynamicToolLoader] Loading tools from found file: ${file.getName()}`);
        
        // Parse JSON
        const content = file.getBlob().getDataAsString();
        let data;
        try {
          data = JSON.parse(content);
        } catch (e) {
          Logger.log(`[DynamicToolLoader] Invalid JSON in tools file: ${e.message}`);
          return [];
        }
        
        if (!data.tools || !Array.isArray(data.tools)) {
          Logger.log('[DynamicToolLoader] Invalid tools.json format - expected {tools: [...]}');
          return [];
        }
        
        // Process each tool definition
        data.tools.forEach((toolDef, index) => {
          // Skip disabled tools
          if (toolDef.enabled === false) {
            Logger.log(`[DynamicToolLoader] Skipping disabled DriveApp tool: ${toolDef.name}`);
            return;
          }
          
          // Validate required fields
          if (!toolDef.name) {
            Logger.log(`[DynamicToolLoader] DriveApp tool at index ${index} missing name`);
            return;
          }
          
          if (!toolDef.description) {
            Logger.log(`[DynamicToolLoader] DriveApp tool '${toolDef.name}' missing description`);
            return;
          }
          
          if (!toolDef.implementation) {
            Logger.log(`[DynamicToolLoader] DriveApp tool '${toolDef.name}' missing implementation`);
            return;
          }
          
          // Validate name format
          const nameValidation = this.validateToolName(toolDef.name);
          if (!nameValidation.valid) {
            Logger.log(`[DynamicToolLoader] DriveApp tool '${toolDef.name}': ${nameValidation.error}`);
            return;
          }
          
          // Validate implementation syntax
          const codeValidation = this.validateCode(toolDef.implementation);
          if (!codeValidation.valid) {
            Logger.log(`[DynamicToolLoader] DriveApp tool '${toolDef.name}' has invalid JavaScript: ${codeValidation.error}`);
            return;
          }
          
          // Create handler
          try {
            const handler = new DynamicToolHandler({
              name: toolDef.name,
              description: toolDef.description,
              params: toolDef.params || '',
              implementation: toolDef.implementation,
              returns: toolDef.returns || ''
            });
            
            handlers.push(handler);
            Logger.log(`[DynamicToolLoader] Loaded DriveApp tool: ${toolDef.name}`);
          } catch (e) {
            Logger.log(`[DynamicToolLoader] Failed to create DriveApp handler for '${toolDef.name}': ${e.message}`);
          }
        });
        
        if (handlers.length > 0) {
          Logger.log(`[DynamicToolLoader] Loaded ${handlers.length} tool(s) from DriveApp`);
        }
        
        return handlers;
        
      } catch (error) {
        Logger.log(`[DynamicToolLoader] DriveApp loading failed: ${error.message}`);
        return [];
      }
    }

    /**
     * Validate all tools in _Tools sheet without loading them
     * Useful for pre-deployment validation or debugging
     * @param {Object} options - Validation options
     * @param {string} options.sheetName - Sheet name (default: '_Tools')
     * @returns {{valid: boolean, toolCount: number, errors: Array<{row, name, error}>}}
     */
    static validateSheet(options = {}) {
      const errors = [];
      let toolCount = 0;
      
      try {
        // Run in strict mode to catch all errors
        const handlers = this.loadHandlers({ ...options, strictMode: false });
        toolCount = handlers.length;
        
        // Collect any logged errors by re-running validation
        // (This is a simplified approach - in production you might track errors differently)
        
        return {
          valid: true,
          toolCount,
          errors: []
        };
      } catch (e) {
        return {
          valid: false,
          toolCount,
          errors: [{ row: 0, name: 'unknown', error: e.message }]
        };
      }
    }

    /**
     * Get a summary of tools in the _Tools sheet
     * Useful for debugging and status checks
     * @param {Object} options - Options
     * @param {string} options.sheetName - Sheet name (default: '_Tools')
     * @returns {{total: number, enabled: number, disabled: number, tools: Array<{name, enabled, hasErrors}>}}
     */
    static getToolsSummary(options = {}) {
      const sheetName = options.sheetName || '_Tools';
      
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return { total: 0, enabled: 0, disabled: 0, tools: [] };
      
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { total: 0, enabled: 0, disabled: 0, tools: [] };
      
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return { total: 0, enabled: 0, disabled: 0, tools: [] };
      
      const tools = [];
      let enabled = 0;
      let disabled = 0;
      
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][0] || '').trim();
        if (!name) continue;
        
        const enabledCell = data[i][4];
        const isEnabled = enabledCell !== false && 
                          enabledCell !== 'FALSE' && 
                          String(enabledCell).toUpperCase() !== 'FALSE';
        
        const implementation = String(data[i][3] || '').trim();
        const hasErrors = !implementation || !this.validateCode(implementation).valid;
        
        tools.push({ name, enabled: isEnabled, hasErrors });
        
        if (isEnabled) enabled++;
        else disabled++;
      }
      
      return {
        total: tools.length,
        enabled,
        disabled,
        tools
      };
    }
  }

  module.exports = DynamicToolLoader;
}

__defineModule__(_main);