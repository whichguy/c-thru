function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * UISupport - Sheets-specific entry point for Claude Chat sidebar
   * Delegates portable chat logic to chat-core/ChatService
   * Contains only SpreadsheetApp-dependent functions and re-exports
   *
   * @module sheets-chat/UISupport
   */

  // Import portable ChatService and re-export all its functions
  const ChatService = require('chat-core/ChatService');

  // Inject Sheets-specific knowledge provider into ChatService
  // This enables knowledge tools when running in Sheets context
  const SheetsKnowledgeProvider = require('sheets-chat/SheetsKnowledgeProvider');
  ChatService.setKnowledgeProvider(SheetsKnowledgeProvider);

  // UI config — document-scope ConfigManager 'UI' namespace
  const ConfigManager = require('common-js/ConfigManager');
  const uiCfg = new ConfigManager('UI');

  // Inject Sheets-specific ToolRegistry into ChatService
  // This enables exec, search, knowledge, prompt, and analyzeUrl tools in Sheets context
  const ToolRegistry = require('tools/ToolRegistry');
  const _toolRegistry = new ToolRegistry({
    enableExec: true,
    enableSearch: true,
    enableKnowledge: true,
    enablePrompt: true,
    enableAnalyzeUrl: true
  });
  ChatService.setToolRegistry(_toolRegistry);

  // Inject constructor tools for interactive chat (read_range, get_sheet_info, scheduler)
  const ReadRangeTool = require('sheets-chat/ReadRangeTool');
  const GetSheetInfoTool = require('sheets-chat/GetSheetInfoTool');
  const SchedulerTools = require('sheets-chat/SchedulerTools');
  ChatService.setInlineTools([
    ReadRangeTool, GetSheetInfoTool,
    SchedulerTools.ScheduleTaskTool, SchedulerTools.ListScheduledTasksTool,
    SchedulerTools.CheckTaskStatusTool, SchedulerTools.GetTaskResultTool,
    SchedulerTools.CancelTaskTool
  ]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEETS-SPECIFIC FUNCTIONS (require SpreadsheetApp)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show sidebar when spreadsheet opens
   */
  function onOpen() {
    log('[onOpen] triggered');
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('Sheets Chat')
      .addItem('Open...', 'showSidebar')
      .addSubMenu(ui.createMenu('Sidebar Width')
        .addItem('Narrow (300px)', 'setSidebarWidthNarrow')
        .addItem('Normal (400px)', 'setSidebarWidthNormal')
        .addItem('Wide (550px)', 'setSidebarWidthWide'))
      .addToUi();
  }

  /**
   * Factory function to create and show sidebar for any environment
   * Delegates to VersionedHtml abstraction for consistency and reusability.
   * @param {string} environment - 'default', 'dev', 'staging', or 'prod'
   */
  function createAndShowSidebar(environment) {
    environment = environment || 'default';
    const { getConfig } = require('chat-core/ChatConstants');
    const sidebarWidth = ChatService.getSidebarWidth(getConfig('UI_SIDEBAR_WIDTH') || 400);

    // Lazy load VersionedHtml to avoid startup failures
    const VersionedHtml = require('common-js/VersionedHtml');

    // Delegate to VersionedHtml abstraction
    VersionedHtml.showSidebar({
      environment: environment,
      view: 'sidebar',
      templatePath: 'sheets-sidebar/Sidebar',
      width: sidebarWidth
    });
  }

  function showSidebar() {
    createAndShowSidebar('default');
    try {
      if (getUiConfig().autoOpenSidebar) _ensureAutoOpenTrigger();
    } catch (e) { log('[showSidebar] trigger install: ' + e.message); }
  }
  function showSidebarDev() { createAndShowSidebar('dev'); }
  function showSidebarStaging() { createAndShowSidebar('staging'); }
  function showSidebarProd() { createAndShowSidebar('prod'); }

  function setSidebarWidthAndReopen(width) {
    var result = ChatService.setSidebarWidth(width);
    if (result && !result.success) {
      log('[setSidebarWidthAndReopen] setSidebarWidth failed: ' + (result.error || 'unknown'));
    }
    createAndShowSidebar('default');
  }
  function setSidebarWidthNarrow() { setSidebarWidthAndReopen(300); }
  function setSidebarWidthNormal() { setSidebarWidthAndReopen(400); }
  function setSidebarWidthWide() { setSidebarWidthAndReopen(550); }

  /**
   * Generate contextual welcome message for fresh sidebar sessions.
   * Ephemeral - not tracked in conversation history or journals.
   * Uses Haiku for speed. Lightweight context only (no ToolRegistry).
   * @returns {Object} {response: string|null}
   */
  function generateWelcomeMessage() {
    try {
      var contextStart = Date.now();
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return { response: null };

      // Sheet overview (fast - no cell reads)
      var sheets = ss.getSheets();
      var sheetsSummary = sheets.map(function(s) {
        return '"' + s.getName() + '" (' + s.getLastRow() + 'x' + s.getLastColumn() + ')';
      }).join(', ');

      // Active sheet headers (single range read)
      var activeSheet = ss.getActiveSheet();
      var lastRow = activeSheet.getLastRow();
      var lastCol = Math.min(activeSheet.getLastColumn(), 20);
      var headers = lastCol > 0
        ? activeSheet.getRange(1, 1, 1, lastCol).getValues()[0].filter(Boolean)
        : [];

      // Knowledge topics (lightweight)
      var knowledgeTopics = '';
      try {
        var knowledgeSheet = ss.getSheetByName('Knowledge');
        if (knowledgeSheet && knowledgeSheet.getLastRow() > 1) {
          var kData = knowledgeSheet.getRange(2, 1, knowledgeSheet.getLastRow() - 1, 2).getValues();
          var topics = kData.map(function(row) { return row[1]; }).filter(Boolean);
          knowledgeTopics = topics.join(', ');
        }
      } catch (e) { log('[generateWelcomeMessage] knowledge read error: ' + e.message); }

      var contextMs = Date.now() - contextStart;

      var prompt = 'You are a helpful assistant in a Google Sheets sidebar. The user just opened a fresh session.\n\n' +
        'Respond with ONLY a JSON object (no markdown, no code fences):\n' +
        '{\n' +
        '  "message": "Your greeting and observations as markdown text (NO action links)",\n' +
        '  "actions": [\n' +
        '    {"label": "Short button label (2-4 words)", "prompt": "Full detailed prompt the user would send", "type": "chat or script"},\n' +
        '    ...3 actions total\n' +
        '  ]\n' +
        '}\n\n' +
        '**Message guidelines:**\n' +
        '- An engaging opener that references their spreadsheet name and what type of work it represents\n' +
        '- 3 bullet points: each an insightful, specific offer showing pattern recognition in their data\n' +
        '- Under 85 words. Warm, conversational tone with contractions. No emojis.\n' +
        '- Be specific with numbers and names from the context below\n' +
        '- Do NOT include [label](prompt:...) links in the message -- actions go in the actions array\n\n' +
        '**Actions guidelines:**\n' +
        '- Exactly 3 actions. Labels are 2-4 words (become clickable buttons).\n' +
        '- Prompts are full, clear instructions the user sends as-is.\n' +
        '- type: "chat" for informational queries, "script" for actions that read/modify the sheet.\n\n' +
        '**Context:**\n' +
        '- Spreadsheet: "' + ss.getName() + '"\n' +
        '- Sheets: ' + sheetsSummary + '\n' +
        '- Active sheet: "' + activeSheet.getName() + '" -- ' + lastRow + ' rows x ' + lastCol + ' cols\n' +
        '- Headers: ' + (headers.length > 0 ? headers.join(', ') : '(none)') + '\n' +
        (knowledgeTopics ? '- Knowledge base topics: ' + knowledgeTopics + '\n' : '');

      var ClaudeApiUtils = require('chat-core/ClaudeApiUtils');
      var result = ClaudeApiUtils.completeJSON(prompt, {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 600
      });
      var totalMs = Date.now() - contextStart;
      log('[generateWelcomeMessage] context=' + contextMs + 'ms, total=' + totalMs + 'ms');
      if (result.success && result.json) {
        return {
          response: result.json.message || result.text,
          actions: result.json.actions || []
        };
      }
      // Fallback: JSON parsing failed, return text-only (chips degrade gracefully)
      if (result.text) {
        log('[generateWelcomeMessage] JSON parse failed, falling back to text');
        return { response: result.text };
      }
      log('[generateWelcomeMessage] Haiku call failed: ' + (result.error || 'unknown'));
      return { response: null };
    } catch (error) {
      log('[generateWelcomeMessage] Error: ' + error.message);
      return { response: null };
    }
  }

  /**
   * Generate contextual follow-up action chips after an assistant response.
   * Sheets surface reads journal and gathers sheet context, then delegates
   * to chat-core/FollowUpSuggestions (pure function: messages in -> suggestions out).
   *
   * @param {string} conversationId - Conversation ID to read from journal
   * @returns {{actions: Array<{label: string, prompt: string, icon: string, type: string}>}}
   */
  function generateFollowUpActions(conversationId) {
    try {
      // Read journal — surface owns the I/O, core stays pure
      var DriveJournal = require('chat-core/DriveJournal');
      var journal = DriveJournal.readJournal(conversationId);
      var messages = (journal.success && journal.data) ? journal.data.messages : [];
      log('[generateFollowUpActions] Journal: success=' + journal.success + ', messages=' + messages.length);
      if (!messages || messages.length === 0) return { actions: [] };

      // Gather Sheets-specific context
      var sheetContext = '';
      try {
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var sheet = ss.getActiveSheet();
        var lastRow = sheet.getLastRow();
        var lastCol = sheet.getLastColumn();
        var headers = lastCol > 0
          ? sheet.getRange(1, 1, 1, Math.min(lastCol, 20)).getValues()[0]
          : [];
        sheetContext = 'Sheet: ' + sheet.getName() + ' (' + lastRow + ' rows, ' + lastCol + ' cols)\nHeaders: ' + headers.filter(Boolean).join(', ');
      } catch (e) {
        // Optional — continue without
      }

      // Build capabilities summary from ToolRegistry (name + args + description)
      var capabilities = '';
      try {
        var tools = _toolRegistry.getEnabledTools();
        capabilities = tools.map(function(t) {
          var desc = (t.description || '').split('.')[0];
          var props = t.input_schema && t.input_schema.properties
            ? Object.keys(t.input_schema.properties) : [];
          var required = t.input_schema && t.input_schema.required || [];
          var argsStr = props.map(function(p) {
            return required.indexOf(p) !== -1 ? p + '*' : p;
          }).join(', ');
          return t.name + '(' + argsStr + '): ' + desc;
        }).join('\n');
      } catch (e) {
        // Optional — continue without
      }

      // Build knowledge summary (type counts only — no values)
      var knowledgeSummary = '';
      try {
        var knowledgeSheet = ss && ss.getSheetByName('Knowledge');
        if (knowledgeSheet && knowledgeSheet.getLastRow() > 1) {
          var kData = knowledgeSheet.getRange(2, 1, knowledgeSheet.getLastRow() - 1, 1).getValues();
          var typeCounts = {};
          kData.forEach(function(row) {
            var type = row[0] || 'general';
            typeCounts[type] = (typeCounts[type] || 0) + 1;
          });
          knowledgeSummary = 'Knowledge base: ' + Object.keys(typeCounts).map(function(t) {
            return t + '(' + typeCounts[t] + ')';
          }).join(', ');
        }
      } catch (e) { log('[generateFollowUpActions] knowledge read error: ' + e.message); }

      // Sheets-specific workflow hints
      var hints =
        'After data write -> sort, filter, format, chart, validate, pivot table\n' +
        'After analysis -> pivot table, chart, QUERY aggregation, export, compare\n' +
        'After formula -> ARRAYFORMULA version, apply to range, error handling, QUERY/FILTER\n' +
        'After large dataset -> pivot table summary, chart, conditional formatting\n' +
        'After formatting -> conditional formatting rules, data validation, freeze rows\n' +
        'Multi-step conversation -> suggest the logical next step in the workflow';

      // Delegate to core — pure function: messages in -> suggestions out
      var FollowUpSuggestions = require('chat-core/FollowUpSuggestions');
      var result = FollowUpSuggestions.suggestFollowUps({
        messages: messages,
        context: sheetContext,
        workflowHints: hints,
        capabilities: capabilities,
        knowledgeSummary: knowledgeSummary
      });
      log('[generateFollowUpActions] Result: ' + (result.actions ? result.actions.length : 0) + ' actions');
      return result;
    } catch (error) {
      log('[generateFollowUpActions] ERROR: ' + error.message);
      return { actions: [] };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART RECOMMENDATIONS (delegate to AmbientEvaluator)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Trigger on-demand analysis — called by sidebar Analyze button
   * @returns {{ success: boolean, count: number }}
   */
  function triggerAnalysis() {
    const AmbientEvaluator = require('sheets-chat/AmbientEvaluator');
    return AmbientEvaluator.runAnalysis('analysis');
  }

  /**
   * Get current recommendation cards — called by 15s sidebar poll.
   * Also appends schedulerNotifications for task completion toasts.
   * @returns {{ recommendations: Array, schedulerNotifications: Array }}
   */
  function getRecommendations() {
    const AmbientEvaluator = require('sheets-chat/AmbientEvaluator');
    const result = AmbientEvaluator.getRecommendations();
    try {
      result.schedulerNotifications = require('then-later/Entrypoints').getCompletedJobNotifications();
    } catch (e) {
      log('[getRecommendations] scheduler notifications: ' + e.message);
      result.schedulerNotifications = [];
    }
    return result;
  }

  /**
   * Direct scheduled wrapper — bypasses idle/cooldown guards so that when Claude
   * explicitly schedules analysis it always runs immediately.
   * Registered in __global__ so JobExecutor.resolveFunction('scheduledAmbientAnalysis') works.
   */
  function scheduledAmbientAnalysis() {
    const AE = require('sheets-chat/AmbientEvaluator');
    return AE.runAnalysis('scheduled');
  }

  /**
   * Scheduled wrapper for exporting the active sheet to Google Drive.
   * Registered in __global__ so JobExecutor.resolveFunction('scheduledExportSheetToDrive') works.
   * @returns {{ success: boolean, fileId?: string, fileName?: string, error?: string }}
   */
  function scheduledExportSheetToDrive() {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return { success: false, error: 'No active spreadsheet' };
      const sheet = ss.getActiveSheet();
      const sheetName = sheet.getName();
      const fileName = ss.getName() + ' - ' + sheetName + ' - ' + new Date().toISOString().slice(0, 10) + '.csv';
      const data = sheet.getDataRange().getValues();
      const csv = data.map(function(row) {
        return row.map(function(cell) {
          var str = String(cell);
          if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
        }).join(',');
      }).join('\n');
      const blob = Utilities.newBlob(csv, 'text/csv', fileName);
      const file = DriveApp.createFile(blob);
      log('[scheduledExportSheetToDrive] Exported: ' + fileName);
      return { success: true, fileId: file.getId(), fileName: fileName };
    } catch (e) {
      log('[scheduledExportSheetToDrive] Error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Dismiss a recommendation card by id — called by card x button
   * @param {string} id - Card UUID
   */
  function dismissRecommendation(id) {
    const AmbientEvaluator = require('sheets-chat/AmbientEvaluator');
    return AmbientEvaluator.dismissRecommendation(id);
  }

  /**
   * Clear all recommendation cards — called when user sends a prompt
   */
  function clearRecommendations() {
    return require('sheets-chat/AmbientEvaluator').clearRecommendations();
  }

  /**
   * Get current advisor configuration — called by config panel on open
   */
  function getAdvisorConfig() {
    return require('sheets-chat/AmbientEvaluator').getConfig();
  }

  /**
   * Set advisor configuration — called by config panel Save button
   * @param {{ enabled?: boolean, minIntervalMs?: number, editDelayMs?: number }} cfg
   */
  function setAdvisorConfig(cfg) {
    return require('sheets-chat/AmbientEvaluator').setAdvisorConfig(cfg);
  }

  /**
   * Get UI configuration — called by config panel on open.
   * Values stored as strings; absent key reads as 'true' (default on).
   * @returns {{ autoOpenSidebar: boolean, responseNotifications: boolean }}
   */
  function getUiConfig() {
    return {
      autoOpenSidebar: uiCfg.get('AUTO_OPEN_SIDEBAR', 'true') !== 'false',
      responseNotifications: uiCfg.get('RESPONSE_NOTIFICATIONS_ENABLED', 'true') !== 'false'
    };
  }

  /**
   * Set UI configuration — called by config panel Save button.
   * @param {{ autoOpenSidebar?: boolean, responseNotifications?: boolean }} cfg
   */
  function setUiConfig(cfg) {
    if (cfg.autoOpenSidebar !== undefined) {
      uiCfg.setDocument('AUTO_OPEN_SIDEBAR', String(cfg.autoOpenSidebar));
      try {
        if (cfg.autoOpenSidebar) _ensureAutoOpenTrigger();
        else _removeAutoOpenTrigger();
      } catch (e) { log('[setUiConfig] trigger management: ' + e.message); }
    }
    if (cfg.responseNotifications !== undefined) {
      uiCfg.setDocument('RESPONSE_NOTIFICATIONS_ENABLED', String(cfg.responseNotifications));
    }
    return { success: true };
  }

  function _ensureAutoOpenTrigger() {
    var exists = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getHandlerFunction() === 'autoOpenSidebarOnOpen';
    });
    if (exists) return;
    ScriptApp.newTrigger('autoOpenSidebarOnOpen')
      .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
      .onOpen()
      .create();
    log('[UISupport] auto-open trigger installed');
  }

  function _removeAutoOpenTrigger() {
    ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === 'autoOpenSidebarOnOpen';
    }).forEach(function(t) { ScriptApp.deleteTrigger(t); });
    log('[UISupport] auto-open trigger removed');
  }

  /**
   * Installable onOpen trigger — runs with FULL auth, can call showSidebar,
   * ScriptApp, and DriveApp. Registered by _ensureAutoOpenTrigger();
   * fires on every spreadsheet open.
   *
   * Calls VersionedHtml.createVersionedShell() directly (bypassing
   * VersionedHtml.showSidebar's internal try/catch which swallows errors into
   * alert() — a no-op in trigger context). Keep opts in sync with
   * createAndShowSidebar() if templatePath/view/environment ever changes.
   */
  function autoOpenSidebarOnOpen() {
    console.log('[autoOpenSidebarOnOpen] trigger fired');
    // Ambient trigger setup (requires FULL auth — ScriptApp)
    try {
      const AE = require('sheets-chat/AmbientEvaluator');
      AE.registerTriggers();
    } catch (e) {
      console.log('[autoOpenSidebarOnOpen] ambient setup error: ' + e.message);
      log('[autoOpenSidebarOnOpen] ambient setup: ' + e.message);
    }
    // Watchdog trigger install (requires FULL auth — ScriptApp + DriveApp)
    try {
      require('then-later/Entrypoints').installWatchdogTrigger();
    } catch (e) {
      console.log('[autoOpenSidebarOnOpen] watchdog error: ' + e.message);
      log('[autoOpenSidebarOnOpen] watchdog install: ' + e.message);
    }
    // Auto-open sidebar — bypass VersionedHtml's error-swallowing alert()
    if (getUiConfig().autoOpenSidebar) {
      try {
        var VersionedHtml = require('common-js/VersionedHtml');
        var { getConfig } = require('chat-core/ChatConstants');
        var width = ChatService.getSidebarWidth(getConfig('UI_SIDEBAR_WIDTH') || 400);
        var html = VersionedHtml.createVersionedShell({
          environment: 'default',
          view: 'sidebar',
          templatePath: 'sheets-sidebar/Sidebar',
          width: width
        });
        SpreadsheetApp.getUi().showSidebar(html.setWidth(width));
        console.log('[autoOpenSidebarOnOpen] sidebar shown');
      } catch (e) {
        console.log('[autoOpenSidebarOnOpen] sidebar error: ' + e.message + ' | ' + e.stack);
        log('[autoOpenSidebarOnOpen] sidebar: ' + e.message);
      }
    } else {
      console.log('[autoOpenSidebarOnOpen] autoOpenSidebar=false, skipping');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GITHUB TOOL SYNC FUNCTIONS (require SpreadsheetApp.getUi())
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync GitHub tools (respects SHA - skips unchanged)
   */
  function syncGitHubTools() {
    const ui = SpreadsheetApp.getUi();
    try {
      const GitHubToolSync = require('tools/GitHubToolSync');
      const result = GitHubToolSync.syncAll();

      if (result.success) {
        ui.alert(
          'Sync Complete',
          'Synced ' + result.sourceCount + ' source(s), ' + result.toolCount + ' tool(s).',
          ui.ButtonSet.OK
        );
      } else {
        const errorMsg = result.errors.map(function(e) { return e.url + ': ' + e.error; }).join('\n');
        ui.alert(
          'Sync Errors',
          'Synced with ' + result.errors.length + ' error(s):\n' + errorMsg,
          ui.ButtonSet.OK
        );
      }
    } catch (error) {
      ui.alert('Sync Failed', error.message, ui.ButtonSet.OK);
    }
  }

  /**
   * Force re-sync all GitHub tools (ignores SHA cache)
   */
  function invalidateAndReloadTools() {
    const ui = SpreadsheetApp.getUi();
    try {
      const GitHubToolSync = require('tools/GitHubToolSync');
      const result = GitHubToolSync.invalidateAndReload();

      if (result.success) {
        ui.alert(
          'Reload Complete',
          'Cache invalidated. Reloaded ' + result.toolCount + ' tool(s) from ' + result.sourceCount + ' source(s).',
          ui.ButtonSet.OK
        );
      } else {
        ui.alert('Reload Failed', result.error || 'Unknown error', ui.ButtonSet.OK);
      }
    } catch (error) {
      ui.alert('Reload Failed', error.message, ui.ButtonSet.OK);
    }
  }

  /**
   * Enable time-based auto-sync trigger
   */
  function enableAutoSync() {
    const ui = SpreadsheetApp.getUi();
    try {
      const existing = ScriptApp.getProjectTriggers().filter(function(t) {
        return t.getHandlerFunction() === 'checkAndSyncGitHubTools';
      });

      if (existing.length > 0) {
        ui.alert('Already Enabled', 'Auto-sync is already enabled.', ui.ButtonSet.OK);
        return;
      }

      ScriptApp.newTrigger('checkAndSyncGitHubTools')
        .timeBased()
        .everyMinutes(5)
        .create();

      ui.alert('Auto-Sync Enabled', 'GitHub tools will sync every 5 minutes (respecting TTL).', ui.ButtonSet.OK);
    } catch (error) {
      ui.alert('Enable Failed', error.message, ui.ButtonSet.OK);
    }
  }

  /**
   * Disable time-based auto-sync trigger
   */
  function disableAutoSync() {
    const ui = SpreadsheetApp.getUi();
    try {
      const triggers = ScriptApp.getProjectTriggers().filter(function(t) {
        return t.getHandlerFunction() === 'checkAndSyncGitHubTools';
      });

      if (triggers.length === 0) {
        ui.alert('Not Enabled', 'Auto-sync is not currently enabled.', ui.ButtonSet.OK);
        return;
      }

      triggers.forEach(function(t) { ScriptApp.deleteTrigger(t); });
      ui.alert('Auto-Sync Disabled', 'Removed ' + triggers.length + ' trigger(s).', ui.ButtonSet.OK);
    } catch (error) {
      ui.alert('Disable Failed', error.message, ui.ButtonSet.OK);
    }
  }

  /**
   * Time-triggered function to check and sync GitHub tools
   */
  function checkAndSyncGitHubTools() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      log('[checkAndSyncGitHubTools] No active spreadsheet');
      return;
    }

    try {
      const GitHubToolSync = require('tools/GitHubToolSync');

      const sources = GitHubToolSync._readToolSources(ss);
      const now = Date.now();
      const defaultTtl = GitHubToolSync._getDefaultTtl();

      for (const source of sources) {
        if (!source.enabled) continue;

        const meta = GitHubToolSync._getMetadata(ss, source.url);
        const lastSync = meta && meta.lastSync ? new Date(meta.lastSync).getTime() : 0;
        const ttl = (source.ttl || defaultTtl) * 1000;

        if (now - lastSync > ttl) {
          log('[checkAndSyncGitHubTools] TTL expired for ' + source.url + ', syncing...');
          GitHubToolSync.syncSource(source.url);
        }
      }
    } catch (error) {
      log('[checkAndSyncGitHubTools] Error: ' + error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE EXPORTS
  // Re-export all ChatService functions for backward compatibility.
  // Client HTML uses CONFIG.api.module = 'sheets-chat/UISupport' unchanged.
  // ═══════════════════════════════════════════════════════════════════════════

  // Start with all ChatService exports (portable functions)
  Object.assign(module.exports, ChatService);

  // Wrap sendMessageToClaude to clear server-side recommendation cache before sending.
  // Sidebar handles idle detection and ambient scheduling via browser setTimeout.
  const _baseSend = ChatService.sendMessageToClaude;
  module.exports.sendMessageToClaude = function(options) {
    try {
      const AE = require('sheets-chat/AmbientEvaluator');
      AE.clearRecommendations();  // clear server cache (sidebar clears UI cards + timer separately)
    } catch (e) { log('[UISupport] pre-send ambient cleanup: ' + e.message); }
    return _baseSend(options);
    // Post-send scheduling removed — sidebar handles idle detection
  };

  // Add Sheets-specific functions
  module.exports.onOpen = onOpen;
  module.exports.showSidebar = showSidebar;
  module.exports.showSidebarDev = showSidebarDev;
  module.exports.showSidebarStaging = showSidebarStaging;
  module.exports.showSidebarProd = showSidebarProd;
  module.exports.setSidebarWidthNarrow = setSidebarWidthNarrow;
  module.exports.setSidebarWidthNormal = setSidebarWidthNormal;
  module.exports.setSidebarWidthWide = setSidebarWidthWide;
  module.exports.generateWelcomeMessage = generateWelcomeMessage;
  module.exports.generateFollowUpActions = generateFollowUpActions;
  module.exports.syncGitHubTools = syncGitHubTools;
  module.exports.invalidateAndReloadTools = invalidateAndReloadTools;
  module.exports.enableAutoSync = enableAutoSync;
  module.exports.disableAutoSync = disableAutoSync;
  module.exports.checkAndSyncGitHubTools = checkAndSyncGitHubTools;
  module.exports.triggerAnalysis = triggerAnalysis;
  module.exports.getRecommendations = getRecommendations;
  module.exports.scheduledAmbientAnalysis = scheduledAmbientAnalysis;
  module.exports.scheduledExportSheetToDrive = scheduledExportSheetToDrive;
  module.exports.dismissRecommendation = dismissRecommendation;
  module.exports.clearRecommendations = clearRecommendations;
  module.exports.getAdvisorConfig = getAdvisorConfig;
  module.exports.setAdvisorConfig = setAdvisorConfig;
  module.exports.getUiConfig = getUiConfig;
  module.exports.setUiConfig = setUiConfig;
  module.exports.autoOpenSidebarOnOpen = autoOpenSidebarOnOpen;

  module.exports.__events__ = { onOpen: 'onOpen' };

  module.exports.__global__ = {
    showSidebar, showSidebarDev, showSidebarStaging, showSidebarProd,
    sendMessageToClaude: module.exports.sendMessageToClaude,
    pollMessages: ChatService.pollMessages,
    clearChat: ChatService.clearChat,
    getConfig: ChatService.getConfig,
    saveConfig: ChatService.saveConfig,
    getOAuthToken: ChatService.getOAuthToken,
    getNextSequenceId: ChatService.getNextSequenceId,
    clearSequenceCounter: ChatService.clearSequenceCounter,
    loadConversationFromJournal: ChatService.loadConversationFromJournal,
    listConversations: ChatService.listConversations,
    getAutoSyncStatus: ChatService.getAutoSyncStatus,
    postCancelRequest: ChatService.postCancelRequest,
    generateWelcomeMessage,
    generateFollowUpActions,
    // Sidebar width menu handlers
    setSidebarWidthNarrow, setSidebarWidthNormal, setSidebarWidthWide,
    // GitHub Tool Sync (menu handlers + trigger)
    syncGitHubTools, invalidateAndReloadTools, enableAutoSync, disableAutoSync, checkAndSyncGitHubTools,
    // Advisor config
    clearRecommendations, getAdvisorConfig, setAdvisorConfig,
    // UI config
    getUiConfig, setUiConfig, autoOpenSidebarOnOpen,
    // Scheduler background task wrappers (resolved by JobExecutor.resolveFunction)
    scheduledAmbientAnalysis: module.exports.scheduledAmbientAnalysis,
    scheduledExportSheetToDrive: module.exports.scheduledExportSheetToDrive
  };
}

__defineModule__(_main, true);
