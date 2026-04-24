function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * SheetsKnowledgeProvider - SpreadsheetApp-based knowledge implementation
 * Implements knowledge operations for ClaudeConversation's KnowledgeProvider interface
 *
 * This module contains all SpreadsheetApp calls that were extracted from ClaudeConversation.gs
 * to keep chat-core/ SpreadsheetApp-free.
 *
 * @module sheets-chat/SheetsKnowledgeProvider
 */

/**
 * Load knowledge from "Knowledge" sheet
 * IMPORTANT: This method NEVER caches - always reads fresh data from sheet
 * @param {Object} toolRegistry - ToolRegistry instance for exec tool access
 * @returns {Array|null} Knowledge data as JSON array or null if not available
 */
function loadKnowledge(toolRegistry) {
  try {
    const execResult = toolRegistry.executeToolCall('exec', {
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
    Logger.log(`[KNOWLEDGE] Failed to load: ${error}`);
    return null;
  }
}

/**
 * Load custom system prompt from _SheetsChat tab (if exists)
 * Checks column A for "SystemPrompt" key and reads value from column B
 * @returns {string|null} Custom prompt or null if not found
 */
function loadCustomSystemPrompt() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const configSheet = ss.getSheetByName('_SheetsChat');

    if (!configSheet) {
      return null;
    }

    const data = configSheet.getDataRange().getValues();

    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === 'SystemPrompt') {
        const customPrompt = data[i][1];

        if (customPrompt && typeof customPrompt === 'string' && customPrompt.trim()) {
          Logger.log(`[SystemPrompt] Loaded custom system prompt from _SheetsChat tab (${customPrompt.length} characters)`);
          return customPrompt;
        }
      }
    }

    return null;
  } catch (error) {
    Logger.log(`[SystemPrompt] Error loading custom prompt: ${error}`);
    return null;
  }
}

/**
 * Append new knowledge entry to the Knowledge sheet
 * @param {Object} input - Tool input
 * @param {string} input.type - Knowledge type/category (column A)
 * @param {string} input.key - Knowledge key/identifier (column B)
 * @param {string} input.value - Knowledge value/content (column C)
 * @param {Object} context - Execution context
 * @param {Function} clearCacheFn - Function to clear knowledge cache
 * @returns {Object} Result with success status and row number
 */
function appendKnowledge(input, context, clearCacheFn) {
  try {
    const { type, key, value } = input;

    if (!type || !key) {
      return { success: false, error: 'type and key are required' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      Logger.log('[KNOWLEDGE] No active spreadsheet — cannot append knowledge');
      return { success: false, error: 'No active spreadsheet' };
    }
    let sheet = ss.getSheetByName('Knowledge');

    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet('Knowledge');
      sheet.getRange(1, 1, 1, 3).setValues([['Type', 'Key', 'Value']]);
      sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    }

    // Coerce non-string values to JSON
    const safeValue = value !== undefined
      ? (typeof value === 'string' ? value : JSON.stringify(value))
      : '';
    const newRow = [type, key, safeValue];
    sheet.appendRow(newRow);

    const lastRow = sheet.getLastRow();

    if (clearCacheFn) clearCacheFn();

    Logger.log(`[KNOWLEDGE] Appended: type=${type}, key=${key}, row=${lastRow}`);

    return {
      success: true,
      result: {
        action: 'append',
        row: lastRow,
        type: type,
        key: key,
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
 * @param {Object} context - Execution context
 * @param {Function} clearCacheFn - Function to clear knowledge cache
 * @returns {Object} Result with success status
 */
function updateKnowledge(input, context, clearCacheFn) {
  try {
    const { row, matchKey, matchType, type, key, value } = input;

    if (!row && !matchKey) {
      return { success: false, error: 'Either row or matchKey is required to identify the entry to update' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      Logger.log('[KNOWLEDGE] No active spreadsheet — cannot update knowledge');
      return { success: false, error: 'No active spreadsheet' };
    }
    const sheet = ss.getSheetByName('Knowledge');

    if (!sheet) {
      return { success: false, error: 'Knowledge sheet not found' };
    }

    let targetRow = row;

    if (!targetRow && matchKey) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const rowType = String(data[i][0] || '').toLowerCase();
        const rowKey = String(data[i][1] || '');

        if (rowKey === matchKey) {
          if (!matchType || rowType === matchType.toLowerCase()) {
            targetRow = i + 1;
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

    const currentValues = sheet.getRange(targetRow, 1, 1, 3).getValues()[0];

    const safeValue = value !== undefined
      ? (typeof value === 'string' ? value : JSON.stringify(value))
      : currentValues[2];

    const newValues = [
      type !== undefined ? type : currentValues[0],
      key !== undefined ? key : currentValues[1],
      safeValue
    ];

    sheet.getRange(targetRow, 1, 1, 3).setValues([newValues]);

    if (clearCacheFn) clearCacheFn();

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
 * @param {Object} context - Execution context
 * @param {Function} clearCacheFn - Function to clear knowledge cache
 * @returns {Object} Result with success status and deleted entry
 */
function deleteKnowledge(input, context, clearCacheFn) {
  try {
    const { row, matchKey, matchType } = input;

    if (!row && !matchKey) {
      return { success: false, error: 'Either row or matchKey is required to identify the entry to delete' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      Logger.log('[KNOWLEDGE] No active spreadsheet — cannot delete knowledge');
      return { success: false, error: 'No active spreadsheet' };
    }
    const sheet = ss.getSheetByName('Knowledge');

    if (!sheet) {
      return { success: false, error: 'Knowledge sheet not found' };
    }

    let targetRow = row;

    if (!targetRow && matchKey) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const rowType = String(data[i][0] || '').toLowerCase();
        const rowKey = String(data[i][1] || '');

        if (rowKey === matchKey) {
          if (!matchType || rowType === matchType.toLowerCase()) {
            targetRow = i + 1;
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

    const deletedValues = sheet.getRange(targetRow, 1, 1, 3).getValues()[0];
    sheet.deleteRow(targetRow);

    if (clearCacheFn) clearCacheFn();

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
 * Get knowledge management tool definitions for ClaudeConversation
 * Returns tool definitions that delegate to this provider's methods
 * @param {Function} clearCacheFn - Function to clear knowledge cache
 * @returns {Array} Array of tool definitions with execute functions
 */
function getKnowledgeManagementTools(clearCacheFn) {
  return [
    {
      name: 'append_knowledge',
      description: 'Add a new entry to the Knowledge sheet - a persistent repository that survives across all conversations and API interactions. Creates sheet with headers if it doesn\'t exist. Note: Does NOT check for duplicates - if type+key already exists, creates another row. Use update_knowledge to modify existing entries. Non-string values are JSON stringified.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Category/type of knowledge (e.g., "general", "url_pattern", "config", "alias")' },
          key: { type: 'string', description: 'Unique identifier or name for this knowledge entry' },
          value: { type: 'string', description: 'The knowledge content, instructions, or data' }
        },
        required: ['type', 'key']
      },
      execute: (input, context) => appendKnowledge(input, context, clearCacheFn)
    },
    {
      name: 'update_knowledge',
      description: 'Update an existing entry in the persistent Knowledge repository (persists across all conversations). REQUIRES either: (1) row - the exact row number (1-indexed, >1), or (2) matchKey - finds first entry matching this key value. Optionally add matchType to narrow search. Only provided fields (type/key/value) are updated. Non-string values are JSON stringified.',
      input_schema: {
        type: 'object',
        properties: {
          row: { type: 'number', description: 'Row number to update (1-indexed, must be > 1 to skip header)' },
          matchKey: { type: 'string', description: 'Find entry by key value (alternative to row number)' },
          matchType: { type: 'string', description: 'Narrow key search to specific type (optional)' },
          type: { type: 'string', description: 'New type value (optional - only updates if provided)' },
          key: { type: 'string', description: 'New key value (optional - only updates if provided)' },
          value: { type: 'string', description: 'New value (optional - only updates if provided)' }
        },
        required: []
      },
      execute: (input, context) => updateKnowledge(input, context, clearCacheFn)
    },
    {
      name: 'delete_knowledge',
      description: 'Delete an entry from the persistent Knowledge repository (changes are permanent across all conversations). REQUIRES either: (1) row - the exact row number (1-indexed, >1), or (2) matchKey - finds first entry matching this key value. Optionally add matchType to narrow search. Returns the deleted entry data.',
      input_schema: {
        type: 'object',
        properties: {
          row: { type: 'number', description: 'Row number to delete (1-indexed, must be > 1 to skip header)' },
          matchKey: { type: 'string', description: 'Find entry by key value (alternative to row number)' },
          matchType: { type: 'string', description: 'Narrow key search to specific type (optional)' }
        },
        required: []
      },
      execute: (input, context) => deleteKnowledge(input, context, clearCacheFn)
    }
  ];
}

module.exports = {
  loadKnowledge,
  loadCustomSystemPrompt,
  appendKnowledge,
  updateKnowledge,
  deleteKnowledge,
  getKnowledgeManagementTools
};
}
__defineModule__(_main);
