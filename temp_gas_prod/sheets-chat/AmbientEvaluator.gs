function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  // Recommendation card schema:
  // { id: string, range: string, type: 'formula|data|pattern|error', text: string (max 120),
  //   actions: [{label: string, prompt: string}], source: 'ambient|analysis', timestamp: number }

  const CACHE_KEY = 'recommendations';
  const CACHE_TTL = 21600; // 6 hours
  const MAX_CARDS = 10;
  const AMBIENT_DAILY_BUDGET = 200;
  const PROCESSING_FLAG = 'AMBIENT_PROCESSING';
  const PROCESSING_TIMESTAMP_FLAG = 'AMBIENT_PROCESSING_TS';
  const STALE_THRESHOLD_MS = 3 * 60 * 1000;  // 3 minutes (covers 3 retries × 30s timeout + margin)

  // Runtime state keys — ConfigManager-relative (ConfigManager prepends AMBIENT_ADVISOR_DATA_)
  const LAST_ANALYSIS_KEY = 'LAST_ANALYSIS_TS';

  // Runtime defaults (used when ConfigManager key absent)
  const DEFAULT_DELAY_MS = 6000;
  const QUICK_DELAY_MS = 1000;
  const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

  // ConfigManager instance — document scope for per-spreadsheet advisor config
  const ConfigManager = require('common-js/ConfigManager');
  const advisorCfg = new ConfigManager('AMBIENT_ADVISOR');

  function getDocCache() {
  const cache = CacheService.getDocumentCache();
  if (!cache) return null;
  return cache;
  }

  function getConfig() {
  return {
    enabled: advisorCfg.get('ENABLED', 'true') !== 'false',
    minIntervalMs: parseInt(advisorCfg.get('MIN_INTERVAL_MS', String(DEFAULT_MIN_INTERVAL_MS)), 10),
    editDelayMs: parseInt(advisorCfg.get('EDIT_DELAY_MS', String(DEFAULT_DELAY_MS)), 10),
    quickDelayMs: parseInt(advisorCfg.get('QUICK_DELAY_MS', String(QUICK_DELAY_MS)), 10)
  };
  }

  function getAdvisorState() {
  const cfg = getConfig();
  if (!cfg.enabled) return { state: 'disabled', enabled: false };

  const props = PropertiesService.getScriptProperties();
  const processing = props.getProperty(PROCESSING_FLAG) === 'true';
  const storedTs = parseInt(props.getProperty(PROCESSING_TIMESTAMP_FLAG) || '0', 10);
  const analyzing = processing && (Date.now() - storedTs < STALE_THRESHOLD_MS);

  const lastAnalysisTs = parseInt(advisorCfg.get(LAST_ANALYSIS_KEY, '0'), 10);
  const { recommendations } = getRecommendationsRaw();

  var state;
  if (analyzing) state = 'analyzing';
  else if (recommendations.length > 0) state = 'showing';
  else state = 'idle';
  // Note: 'pending' state removed — sidebar tracks its own timer via window._ambientTimer

  var cooldownRemainingMs = 0;
  if (lastAnalysisTs > 0) {
    var elapsed = Date.now() - lastAnalysisTs;
    if (elapsed < cfg.minIntervalMs) cooldownRemainingMs = cfg.minIntervalMs - elapsed;
  }
  var budgetInfo = checkDailyBudget();

  return {
    state: state, enabled: true, lastAnalysisTs: lastAnalysisTs,
    cardCount: recommendations.length,
    cooldownRemainingMs: cooldownRemainingMs,
    budgetUsed: budgetInfo.count, budgetTotal: budgetInfo.budget
  };
  }

  // Internal — called by getAdvisorState and getRecommendations
  function getRecommendationsRaw() {
  try {
    const cache = getDocCache();
    var raw = cache ? cache.get(CACHE_KEY) : null;
    // Fallback: saveRecommendations writes to ScriptProperties when cache unavailable
    if (!raw) {
      raw = PropertiesService.getScriptProperties().getProperty(CACHE_KEY);
    }
    if (!raw) return { recommendations: [] };
    const parsed = JSON.parse(raw);
    return { recommendations: Array.isArray(parsed) ? parsed : [] };
  } catch (e) {
    log(`[AmbientEvaluator] getRecommendationsRaw error: ${e.message}`);
    return { recommendations: [] };
  }
  }

  // Public — enriched with advisor state (called from UISupport → sidebar poll)
  function getRecommendations() {
  const result = getRecommendationsRaw();
  result.advisorState = getAdvisorState();
  return result;
  }

  function saveRecommendations(cards) {
  try {
    const cache = getDocCache();
    if (!cache) {
      PropertiesService.getScriptProperties().setProperty(CACHE_KEY, JSON.stringify(cards));
      return;
    }
    cache.put(CACHE_KEY, JSON.stringify(cards), CACHE_TTL);
  } catch (e) {
    log(`[AmbientEvaluator] saveRecommendations error: ${e.message}`);
  }
  }

  function dismissRecommendation(id) {
  try {
    const { recommendations } = getRecommendationsRaw();
    const filtered = recommendations.filter(c => c.id !== id);
    saveRecommendations(filtered);
    return { success: true, remaining: filtered.length };
  } catch (e) {
    log(`[AmbientEvaluator] dismissRecommendation error: ${e.message}`);
    return { success: false, remaining: 0, error: e.message };
  }
  }

  function clearRecommendations() {
  try {
    saveRecommendations([]);
    log('[AmbientEvaluator] recommendations cleared');
    return { success: true };
  } catch (e) {
    log(`[AmbientEvaluator] clearRecommendations error: ${e.message}`);
    return { success: false, error: e.message };
  }
  }

  function setAdvisorConfig({ enabled, minIntervalMs, editDelayMs }) {
  try {
    if (enabled !== undefined) advisorCfg.setDocument('ENABLED', String(enabled));
    if (minIntervalMs !== undefined) advisorCfg.setDocument('MIN_INTERVAL_MS', String(minIntervalMs));
    if (editDelayMs !== undefined) advisorCfg.setDocument('EDIT_DELAY_MS', String(editDelayMs));

    if (enabled === false) {
      saveRecommendations([]);
      // Note: cancelIdleCheck removed — sidebar clears its own timer
    }
    // Note: when enabled === true, no server-side scheduling; sidebar schedules on next response
    return { success: true };
  } catch (e) {
    log(`[AmbientEvaluator] setAdvisorConfig error: ${e.message}`);
    return { success: false, error: e.message };
  }
  }

  function checkAndSetProcessingFlag() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return false;
  try {
    const props = PropertiesService.getScriptProperties();
    const storedTs = parseInt(props.getProperty(PROCESSING_TIMESTAMP_FLAG) || '0', 10);
    const storedFlag = props.getProperty(PROCESSING_FLAG);
    const age = Date.now() - (isNaN(storedTs) ? 0 : storedTs);
    if (storedFlag === 'true' && age < STALE_THRESHOLD_MS) return false;
    props.setProperties({
      [PROCESSING_FLAG]: 'true',
      [PROCESSING_TIMESTAMP_FLAG]: String(Date.now())
    });
    return true;
  } finally {
    lock.releaseLock();
  }
  }

  function clearProcessingFlag() {
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(PROCESSING_FLAG);
    props.deleteProperty(PROCESSING_TIMESTAMP_FLAG);
  } catch (e) {
    log(`[AmbientEvaluator] clearProcessingFlag error: ${e.message}`);
  }
  }

  function checkDailyBudget() {
  const today = new Date().toISOString().slice(0, 10);
  const key = `AMBIENT_CALLS_${today}`;
  const props = PropertiesService.getScriptProperties();
  const count = parseInt(props.getProperty(key) || '0', 10);
  const budget = parseInt(props.getProperty('AMBIENT_DAILY_BUDGET') || String(AMBIENT_DAILY_BUDGET), 10);
  return { count, budget, ok: count < budget, key };
  }

  function incrementBudgetCounter(key) {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) {
      log('[AmbientEvaluator] incrementBudgetCounter: could not acquire lock');
      return;
    }
    try {
      const props = PropertiesService.getScriptProperties();
      const count = parseInt(props.getProperty(key) || '0', 10);
      props.setProperty(key, String(count + 1));
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    log(`[AmbientEvaluator] incrementBudgetCounter error: ${e.message}`);
  }
  }

  function callSonnet(sheetInfo, dataValues, knowledgeSummary) {
  const ClaudeApiUtils = require('chat-core/ClaudeApiUtils');
  const prompt = `You are a spreadsheet analyst. Analyze this spreadsheet data and generate actionable recommendations.

  ## Step 1: Profile the Data

  Classify each column: temporal (dates/timestamps), numeric (amounts/rates/currency), categorical (labels/statuses, <20 unique), identifier (IDs/codes/keys), email, text (descriptions/notes).

  ## Step 2: Recognize the Domain

  Identify the domain from headers and values. Common patterns:
  Sales (Deal, Stage, Revenue), HR (Employee, Salary, Department), Finance (Account, Debit, Credit).
  For ANY domain: match analysis to data semantics — financial→margins/aging, people→distributions/tenure, pipeline→conversion/funnel, inventory→reorder/turnover.

  ## Step 3: Generate Recommendations

  Draw from ALL of these categories:
  - insight: statistical observation the user probably hasn't noticed (trends, spikes, outliers, correlations)
  - charting: match data shape to chart type (see heuristics below) or pivot table
  - quality: data cleanliness issues (nulls, duplicates, mixed types, inconsistent formats)
  - formula: QUERY, ARRAYFORMULA, FILTER for automation
  - join: cross-sheet VLOOKUP, INDEX/MATCH, IMPORTRANGE
  - data: sort, filter, deduplicate, validate, standardize
  - comparison: cross-column or cross-sheet relationships worth exploring
  - messaging: email summaries with key metrics, share formatted reports
  - formatting: number formats, date formats, conditional formatting for thresholds

  Chart and pivot table heuristics — match data shape:
  - Temporal + numeric → line chart showing trend over time
  - Categorical (<8 groups) + numeric → bar chart comparing groups
  - Part-of-whole (percentages summing to ~100%) → pie chart (max 6 slices)
  - Two numeric columns → scatter plot (if >20 rows)
  - Temporal + categorical + numeric → grouped bar or multi-line chart
  - Single numeric (many rows) → histogram for distribution
  - Temporal + categorical + numeric (stacked) → area chart for cumulative trends
  - Two metrics with different scales → combo chart (bars + line, dual y-axis)
  - Single metric per row (compact trend) → SPARKLINE formula for in-cell mini-chart
  - Numeric range needing visual encoding → gradient conditional formatting (heat map) via ConditionalFormatRuleBuilder
  - Categorical + numeric (many groups or cross-tab) → pivot table (sheet.createPivotTable()) with SUM/AVG/COUNT

  Calculated column scans: numeric pairs → derived metric via ARRAYFORMULA (Qty×Price, Margin%), date → age (Days Since), numeric → threshold category (IF-based). Cross-sheet lookup → VLOOKUP (simple key) or INDEX-MATCH (compound key). Filtered aggregation → QUERY. Suggest exact formula, header name, and target cell.

  Advanced formulas: LAMBDA/MAP/REDUCE for custom array operations; PERCENTILE/FREQUENCY/RANK for distribution analysis; CORREL/LINEST for correlation/regression; data validation (dropdowns via requireValueInList, checkboxes via requireCheckbox) for interactive sheets.
  Polish: applyRowBanding() for instant table styling.

  Cross-sheet joins: scan allSheets for matching column headers or ID-like columns (unique, non-null, numeric/alphanumeric codes). Detect compound keys (two+ columns that together uniquely identify rows, e.g., Date+Region, OrderID+LineItem). Suggest INDEX/MATCH for compound keys, VLOOKUP for simple keys. If a useful lookup table doesn't exist, suggest creating a reference sheet.

  Anomaly scanning: for numeric columns, check for values >2 standard deviations from mean (outliers), sudden period-over-period changes >30%, empty clusters in otherwise complete data, duplicate rows on key columns, and skewed distributions. Flag specific rows/ranges, not vague patterns.

  If data could benefit from external reference data (exchange rates, zip-to-region mapping, industry benchmarks), suggest IMPORTDATA(url) for published CSV/JSON or UrlFetchApp for APIs.

  Always name specific columns, ranges, and suggest chart/pivot titles.

  All sheets in workbook: ${JSON.stringify(sheetInfo.allSheets || sheetInfo)}
  Active sheet info: ${JSON.stringify(sheetInfo)}
  Data sample: ${JSON.stringify(dataValues)}
  ${knowledgeSummary ? `\nUser knowledge base context: ${knowledgeSummary}\nConsider knowledge entries when generating recommendations — suggest actions that reference or build on saved patterns/URLs.` : ''}

  Respond ONLY as JSON (no fences):
  {"recommendations": [{"range": "Sheet!A1:Z100 or column header", "type": "insight|charting|quality|formula|join|data|comparison|messaging|formatting", "text": "str (max 120 chars)", "actions": [{"label": "3-5 word button text", "prompt": "follow-up instruction referencing sheet/range"}]}]}
  Max 5 recommendations, max 2 actions each. Prioritize insight, charting, and domain-specific actions over generic formatting. Reference specific sheet names and cell ranges.`;

  const result = ClaudeApiUtils.completeJSON(prompt, {
    model: 'claude-sonnet-4-6',
    maxTokens: 1536
  });

  if (!result.success) {
    throw new Error(`Sonnet call failed: ${result.error}`);
  }

  return result.json;
  }

  function runAnalysis(source) {
  source = source || 'analysis';
  log(`[AmbientEvaluator] runAnalysis start, source=${source}`);

  try {
    const GetSheetInfoTool = require('sheets-chat/GetSheetInfoTool');
    const ReadRangeTool = require('sheets-chat/ReadRangeTool');

    const infoResult = GetSheetInfoTool.execute({});
    if (!infoResult.success) {
      log(`[AmbientEvaluator] GetSheetInfoTool failed: ${infoResult.error}`);
      return { success: false, error: infoResult.error };
    }

    const sheetInfo = infoResult.result;
    const sheetName = sheetInfo.activeSheet;
    const rows = Math.min(sheetInfo.rows, 100);
    const cols = Math.min(sheetInfo.cols, 20);

    let dataValues = [];
    if (rows > 0 && cols > 0) {
      const rangeA1 = `${sheetName}!A1:${colLetter(cols)}${rows}`;
      const readResult = ReadRangeTool.execute({ range: rangeA1 });
      if (readResult.success) {
        dataValues = readResult.result.values;
      } else {
        log(`[AmbientEvaluator] ReadRangeTool warning: ${readResult.error}`);
      }
    }

    // Build knowledge summary for context-aware recommendations
    let knowledgeSummary = '';
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const knowledgeSheet = ss && ss.getSheetByName('Knowledge');
      if (knowledgeSheet && knowledgeSheet.getLastRow() > 1) {
        const kData = knowledgeSheet.getRange(2, 1, knowledgeSheet.getLastRow() - 1, 2).getValues();
        const typeCounts = {};
        const topics = [];
        kData.forEach(row => {
          const type = String(row[0] || 'general');
          typeCounts[type] = (typeCounts[type] || 0) + 1;
          if (row[1]) topics.push(String(row[1]).substring(0, 50));
        });
        const summary = Object.keys(typeCounts).map(t => `${t}(${typeCounts[t]})`).join(', ');
        knowledgeSummary = `Knowledge base: ${summary}. Topics: ${topics.slice(0, 10).join('; ')}`;
      }
    } catch (e) { log(`[AmbientEvaluator] knowledge read error: ${e.message}`); }

    const parsed = callSonnet(sheetInfo, dataValues, knowledgeSummary);
    const rawCards = (parsed && Array.isArray(parsed.recommendations)) ? parsed.recommendations : [];

    const cards = rawCards.slice(0, 5).map(c => ({
      id: Utilities.getUuid(),
      range: c.range || '',
      type: c.type || 'data',
      text: (c.text || '').slice(0, 120),
      actions: Array.isArray(c.actions) ? c.actions.slice(0, 2) : [],
      source: source,
      timestamp: Date.now()
    }));

    if (source === 'analysis') {
      // On-demand: replace all existing cards
      saveRecommendations(cards);
    } else {
      // Ambient: merge (dedup by range, max MAX_CARDS)
      const { recommendations: existing } = getRecommendationsRaw();
      const merged = [...cards];
      for (const existing_card of existing) {
        if (!merged.find(c => c.range === existing_card.range)) {
          merged.push(existing_card);
        }
      }
      saveRecommendations(merged.slice(0, MAX_CARDS));
    }

    log(`[AmbientEvaluator] runAnalysis complete, ${cards.length} new cards, source=${source}`);
    return { success: true, count: cards.length };
  } catch (e) {
    log(`[AmbientEvaluator] runAnalysis error: ${e.message}`);
    return { success: false, error: e.message };
  }
  }

  function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
  }

  // One-shot server function called by sidebar after 60s idle timer fires.
  // Enforces cooldown atomically — sidebar cannot bypass the 5-min gate.
  function runAmbientIfReady() {
  const cfg = getConfig();
  if (!cfg.enabled) return { success: false, skipped: 'disabled' };

  const lastAnalysis = parseInt(advisorCfg.get(LAST_ANALYSIS_KEY, '0'), 10);
  if (Date.now() - lastAnalysis < cfg.minIntervalMs) {
    const remainingMs = cfg.minIntervalMs - (Date.now() - lastAnalysis);
    log(`[AmbientEvaluator] runAmbientIfReady: cooldown active (${Math.round(remainingMs / 1000)}s remaining)`);
    return { success: false, skipped: 'cooldown', remainingMs };
  }

  const { ok, key } = checkDailyBudget();
  if (!ok) { log('[AmbientEvaluator] runAmbientIfReady: budget exhausted'); return { success: false, skipped: 'budget' }; }
  if (!checkAndSetProcessingFlag()) { log('[AmbientEvaluator] runAmbientIfReady: already processing'); return { success: false, skipped: 'processing' }; }

  try {
    const result = runAnalysis('ambient');
    if (result.success) {
      advisorCfg.setScript(LAST_ANALYSIS_KEY, String(Date.now()));
      incrementBudgetCounter(key);
      // Return cards directly so sidebar can render without waiting for 15s poll
      const { recommendations } = getRecommendationsRaw();
      return { success: true, count: result.count, recommendations };
    } else {
      // Error cooldown: encode 60s retry so 5-min gate blocks rapid retries
      const ERROR_RETRY_MS = 60 * 1000;
      const minMs = Number(cfg.minIntervalMs);
      const cooldownTs = Number.isFinite(minMs) ? Date.now() - minMs + ERROR_RETRY_MS : Date.now();
      advisorCfg.setScript(LAST_ANALYSIS_KEY, String(cooldownTs));
      return result;
    }
  } catch (e) {
    log(`[AmbientEvaluator] runAmbientIfReady error: ${e.message}`);
    const ERROR_RETRY_MS = 60 * 1000;
    const minMs = Number(cfg.minIntervalMs);
    const cooldownTs = Number.isFinite(minMs) ? Date.now() - minMs + ERROR_RETRY_MS : Date.now();
    advisorCfg.setScript(LAST_ANALYSIS_KEY, String(cooldownTs));
    return { success: false, error: e.message };
  } finally {
    clearProcessingFlag();
  }
  }

  function registerTriggers() {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
      log('[AmbientEvaluator] registerTriggers: could not acquire lock');
      return { success: false, error: 'Lock not acquired' };
    }
    try {
      // Sweep stale one-shot idleCheck triggers (migration cleanup)
      ScriptApp.getProjectTriggers()
        .filter(t => t.getHandlerFunction() === 'ambientEvaluatorIdleCheck')
        .forEach(t => ScriptApp.deleteTrigger(t));

      // Legacy: remove old installable onEdit trigger (now handled by __events__)
      const oldOnEdit = ScriptApp.getProjectTriggers()
        .find(t => t.getHandlerFunction() === 'ambientEvaluatorOnEdit');
      if (oldOnEdit) {
        ScriptApp.deleteTrigger(oldOnEdit);
        log('[AmbientEvaluator] removed legacy installable onEdit trigger');
      }

      // Legacy: remove 5-minute cron if present
      const legacyCron = ScriptApp.getProjectTriggers()
        .find(t => t.getHandlerFunction() === 'ambientEvaluatorProcessQueue');
      if (legacyCron) {
        ScriptApp.deleteTrigger(legacyCron);
        log('[AmbientEvaluator] removed legacy cron trigger');
      }

      // Migration: delete old raw property keys (pre-ConfigManager storage)
      const props = PropertiesService.getScriptProperties();
      props.deleteProperty('AMBIENT_IDLE_TRIGGER_ID');
      props.deleteProperty('AMBIENT_LAST_ACTIVITY');

      // Clean up stale daily budget keys (older than today)
      const today = new Date().toISOString().slice(0, 10);
      props.getKeys()
        .filter(k => k.startsWith('AMBIENT_CALLS_') && k !== 'AMBIENT_CALLS_' + today)
        .forEach(k => props.deleteProperty(k));

      return { success: true };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    log(`[AmbientEvaluator] registerTriggers error: ${e.message}`);
    return { success: false, error: e.message };
  }
  }

  function removeTimeTrigger() {
  try {
    const toRemove = ['ambientEvaluatorProcessQueue', 'ambientEvaluatorIdleCheck'];
    // Also clean up legacy installable onEdit if present
    const triggers = ScriptApp.getProjectTriggers().filter(t =>
      toRemove.includes(t.getHandlerFunction()) ||
      t.getHandlerFunction() === 'ambientEvaluatorOnEdit'
    );
    triggers.forEach(t => ScriptApp.deleteTrigger(t));
    const props = PropertiesService.getScriptProperties();
    // Migration: remove old raw property keys
    props.deleteProperty('AMBIENT_IDLE_TRIGGER_ID');
    props.deleteProperty('AMBIENT_LAST_ACTIVITY');
    props.deleteProperty('AMBIENT_LAST_ANALYSIS_TS');
    // Remove via ConfigManager (new key location)
    advisorCfg.delete(LAST_ANALYSIS_KEY, 'script');
    log(`[AmbientEvaluator] removed ${triggers.length} trigger(s)`);
    return { success: true, removed: triggers.length };
  } catch (e) {
    log(`[AmbientEvaluator] removeTimeTrigger error: ${e.message}`);
    return { success: false, error: e.message };
  }
  }

  module.exports = {
  runAmbientIfReady,
  runAnalysis,
  getRecommendations,
  dismissRecommendation,
  clearRecommendations,
  getAdvisorState,
  getConfig,
  setAdvisorConfig,
  registerTriggers,
  removeTimeTrigger
  };
}

__defineModule__(_main, true);