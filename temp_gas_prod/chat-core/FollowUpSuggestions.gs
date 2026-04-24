function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  var ClaudeApiUtils = require('chat-core/ClaudeApiUtils');

  /**
   * Extract tool summary from assistant message content blocks.
   * Returns [{tool, description?}] or null.
   */
  function _extractToolSummary(content) {
    if (!Array.isArray(content)) return null;
    var toolBlocks = content.filter(function(b) { return b && b.type === 'tool_use'; });
    if (toolBlocks.length === 0) return null;
    return toolBlocks.map(function(b) {
      var summary = { tool: b.name };
      if (b.input && b.input.description) {
        summary.description = b.input.description.substring(0, 100);
      }
      return summary;
    });
  }

  /**
   * Extract conversation context from messages for follow-up generation.
   * Pure function — no I/O, operates on provided messages array.
   * Returns { userMessage, assistantResponse, digest, toolSummary } or null.
   */
  function _readConversationContext(messages) {
    if (!messages || messages.length < 2) return null;

    var lastUser = null, lastAssistant = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      var msg = messages[i];
      if (!lastAssistant && msg.role === 'assistant') {
        lastAssistant = msg;
      } else if (!lastUser && msg.role === 'user') {
        if (ClaudeApiUtils.isToolResultMessage(msg)) continue;
        lastUser = msg;
      }
      if (lastUser && lastAssistant) break;
    }
    if (!lastUser || !lastAssistant) return null;

    var lastUserIdx = -1;
    for (var j = messages.length - 1; j >= 0; j--) {
      var jMsg = messages[j];
      if (jMsg.role === 'user' && !ClaudeApiUtils.isToolResultMessage(jMsg)) {
        lastUserIdx = j;
        break;
      }
    }
    var prior = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : [];
    var meaningful = prior.filter(function(m) {
      if (ClaudeApiUtils.isToolResultMessage(m)) return false;
      if (ClaudeApiUtils.isToolUseOnlyMessage(m)) return false;
      return true;
    });
    var recent = meaningful.slice(-6);
    var digestLines = [];
    recent.forEach(function(m) {
      var text = ClaudeApiUtils.extractTextFromContent(m.content);
      if (!text) return;
      if (text.length > 200) {
        text = `${text.substring(0, 100)}...${text.substring(text.length - 100)}`;
      }
      digestLines.push(`${m.role.toUpperCase()}: ${text}`);
    });

    return {
      userMessage: ClaudeApiUtils.extractTextFromContent(lastUser.content),
      assistantResponse: ClaudeApiUtils.extractTextFromContent(lastAssistant.content),
      digest: digestLines.join('\n'),
      toolSummary: _extractToolSummary(lastAssistant.content)
    };
  }

  /**
   * Generate follow-up action suggestions using Haiku.
   * Pure function — messages in, suggestions out. No I/O dependencies.
   *
   * @param {Object} options
   * @param {Array} options.messages - Conversation messages array
   * @param {string} [options.context] - Surface-specific context (sheet info, email info, etc.)
   * @param {string} [options.workflowHints] - Surface-specific workflow progression rules
   * @param {string} [options.capabilities] - Available tool capabilities summary
   * @param {string} [options.knowledgeSummary] - Knowledge base type/count summary
   * @returns {Object} { actions: [{label, prompt, icon, type, target?}] }
   */
  function suggestFollowUps(options) {
    try {
      if (!options.messages || options.messages.length === 0) return { actions: [] };

      var ctx = _readConversationContext(options.messages);
      log(`[FollowUpSuggestions] Context: user=${ctx ? ctx.userMessage.length : 'null'}, assistant=${ctx ? ctx.assistantResponse.length : 'null'} chars`);
      if (!ctx || !ctx.assistantResponse) return { actions: [] };

      var truncatedResponse = ctx.assistantResponse.substring(0, 1500);
      var truncatedUser = ctx.userMessage.substring(0, 500);

      var toolContext = '';
      if (ctx.toolSummary && ctx.toolSummary.length > 0) {
        var toolLines = ctx.toolSummary.map(function(t) {
          return `- ${t.tool}${t.description ? `: ${t.description}` : ''}`;
        });
        toolContext = `\nTools used this turn:\n${toolLines.join('\n')}`;
      }

      var historyContext = '';
      if (ctx.digest) {
        historyContext = `\nPrior conversation:\n${ctx.digest}`;
      }

      var prompt =
        'You are a spreadsheet analyst. Return ONLY valid JSON with no commentary: {"actions": [...]}\n' +
        'Schema: {"label": "2-4 words", "prompt": "instruction with sheet+range", ' +
        '"icon": "material_icon", "type": "chat|script", "target": "Sheet!Range"}\n\n' +

        'Rules:\n' +
        '1. Return 4-6 actions for standard exchanges, up to 8 when data is rich and multiple categories are clearly relevant. Return {"actions":[]} for greetings/simple answers.\n' +
        '2. type "script" = modifies/reads data, include target. type "chat" = analytical inquiry, omit target.\n' +
        '3. Max 2 "chat" actions per set when data patterns warrant investigation.\n' +
        '4. Label: verb-first, 2-4 words, specific. Good: "Aggregate by Month", "Join Customer Data", "Chart Revenue Trend". Bad: "Data Analysis", "Formula Suggestion".\n' +
        '5. Every prompt must name a specific sheet, column, or range from context.\n' +
        '6. Never suggest what was just done or a close variation.\n' +
        '7. Order: quick next-steps first, then discovery actions the user would not think of.\n\n' +

        'Prioritization:\n' +
        '1. If prior response surfaced anomaly/pattern → lead with ANALYTICAL chat probe.\n' +
        '2. If data has clear structure → FORMULA & COLUMNS or VISUALIZATION.\n' +
        '3. If domain recognizable → include 1 DOMAIN-SPECIFIC action.\n' +
        '4. Max 2 chat (analytical), rest script (actions). Don\'t repeat categories.\n' +
        '5. Quick next-steps first, then discovery actions user wouldn\'t think of.\n\n' +

        'Draw from the most relevant categories:\n' +
        '- FORMULA & COLUMNS: Row-by-row calc→ARRAYFORMULA (Qty×Price, IF threshold, date→age); filtered/aggregated view→QUERY (SELECT/WHERE/GROUP BY); conditional subset→FILTER; cross-sheet lookup→VLOOKUP (simple key) or INDEX-MATCH (compound key); external→IMPORTDATA. Detect manually entered totals replaceable by formula. Suggest exact formula + header + placement.\n' +
        '- COLUMN/FORMAT: Dates without format→date format; money→$#,##0.00; 0–1 values→0.0% percent.\n' +
        '- CROSS-SHEET: Matching columns/IDs→VLOOKUP; compound keys (Date+Region)→INDEX/MATCH with helper column; other workbook→IMPORTRANGE; published CSV→IMPORTDATA/IMPORTHTML. If lookup table missing, suggest creating a reference sheet.\n' +
        '- VISUALIZATION: temporal+numeric→line; categorical+numeric→bar; <6 groups→pie; two numerics→scatter; numeric distribution→histogram. Specify columns, type, title. Type:"script" via sheet.newChart(). Include conditional formatting/color scales for thresholds.\n' +
        '- PIVOT TABLE: categorical+numeric→pivot (sheet.createPivotTable()). Name row group, values (SUM/AVG/COUNT), optional col group. Good: "Pivot Revenue by Region and Quarter".\n' +
        '- DATA: sort, filter, deduplicate, validate when nulls/duplicates/type mismatches present.\n' +
        '- ANALYTICAL: anomaly/spike/pattern→chat probe. Scan: >2σ outliers, >30% period change, duplicates on keys, skewed distributions. Stats: mean/median/stdev, top-N, correlation, percentile, period-over-period. Frame as specific questions with column names. Type:"chat".\n' +
        '- DOMAIN-SPECIFIC: Infer domain from headers (anchor: Sales/HR/Finance; dynamic for all others)→1 highest-value domain-expert action. Max 1 per set.\n' +
        '- COMMUNICATE: Email summary (GmailApp.createDraft), formatted "Report" sheet, copy for sharing. Structure as narrative: Hook (key insight) → Evidence → Recommendation.\n' +
        '- MONITORING: Data changes over time→schedule_script for recurring checks. Leverage repeatIntervalMs/weeklyDays.\n' +
        '- KNOWLEDGE: save finding to knowledge base, search knowledge for patterns. Use when response produced a reusable insight, or user\'s question might match a saved knowledge entry.\n\n' +

        '### Example\n' +
        'User: How many rows have missing emails?\n' +
        'Assistant: Found 23 of 150 rows with empty Email column in Contacts, mostly rows 50-80.\n' +
        '{"actions": [\n' +
        '{"label": "Highlight empty cells", "prompt": "Highlight all empty cells in the Email column of Contacts (E2:E150) with red background", "icon": "format_color_fill", "type": "script", "target": "Contacts!E2:E150"},\n' +
        '{"label": "Export affected rows", "prompt": "Create a new sheet with the 23 rows from Contacts that have missing emails", "icon": "content_copy", "type": "script", "target": "Contacts!A1:Z150"},\n' +
        '{"label": "Add email validation", "prompt": "Add data validation to the Email column in Contacts (E2:E150) requiring valid email format", "icon": "rule", "type": "script", "target": "Contacts!E2:E150"},\n' +
        '{"label": "ARRAYFORMULA completeness", "prompt": "Add an ARRAYFORMULA in a new column of Contacts to flag rows with missing Email as \'Incomplete\'", "icon": "functions", "type": "script", "target": "Contacts!F2"},\n' +
        '{"label": "Investigate distribution", "prompt": "Summarize the data completeness patterns across all columns in Contacts — which columns have the most gaps?", "icon": "analytics", "type": "chat"}\n' +
        ']}\n\n' +

        (options.workflowHints ? `### Workflow\n${options.workflowHints}\n\n` : '') +

        '### Context\n' +
        `User: ${truncatedUser}\n` +
        `Assistant: ${truncatedResponse}` +
        historyContext +
        (options.context ? `\n${options.context}` : '') +
        toolContext +
        (options.knowledgeSummary ? `\n${options.knowledgeSummary}` : '') +
        (options.capabilities ? `\nAvailable tools: ${options.capabilities}` : '');

      var result = ClaudeApiUtils.completeJSON(prompt, {
        model: 'claude-sonnet-4-6',
        maxTokens: 800
      });
      log(`[FollowUpSuggestions] Sonnet result: success=${result.success}, actions=${result.json && result.json.actions ? result.json.actions.length : 'none'}`);

      if (result.success && result.json && result.json.actions) {
        return { actions: result.json.actions.slice(0, 8) };
      }
      return { actions: [] };
    } catch (error) {
      log(`[FollowUpSuggestions] Error: ${error.message}`);
      return { actions: [] };
    }
  }

  module.exports = {
    suggestFollowUps: suggestFollowUps,
    // Exposed for unit testing only
    _readConversationContext: _readConversationContext,
    _extractToolSummary: _extractToolSummary
  };
}

__defineModule__(_main);