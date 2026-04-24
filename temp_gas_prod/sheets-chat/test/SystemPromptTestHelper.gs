function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * SystemPromptTestHelper - Shared helper for system prompt A/B comparison tests
   * 
   * Sends the same prompt to V2 (control) and a configurable variant,
   * captures responses + tool use, and supports Opus pairwise judging.
   * 
   * Config (via ConfigManager SHEETS_CHAT scope):
   *   ABTEST_VARIANT: 'V2a' | 'V2b' | 'V2c' (default: 'V2a')
   *   ABTEST_MODEL:   'haiku' | 'sonnet' | 'opus' (default: 'haiku')
   */

  const VARIANTS = {
    V2: 'buildSystemPromptV2',
    V2a: 'buildSystemPromptV2a',
    V2b: 'buildSystemPromptV2b',
    V2c: 'buildSystemPromptV2c'
  };

  const MODELS = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-5-20250929',
    opus: 'claude-opus-4-6'
  };

  // Module-level storage for test results (persists within single GAS execution)
  var _results = [];

  function getActiveVariant() {
    var CM = require('common-js/ConfigManager');
    return new CM('SHEETS_CHAT').get('ABTEST_VARIANT', 'V2a');
  }

  function getActiveModel() {
    var CM = require('common-js/ConfigManager');
    return new CM('SHEETS_CHAT').get('ABTEST_MODEL', 'haiku');
  }

  /**
   * Send the same prompt to V2 (control) and variant, each in a fresh conversation.
   * @param {string} prompt - User message to send
   * @param {Object} [options] - Override variant, model, maxTokens
   * @returns {{ control, variant, variantName, modelId, modelKey }}
   */
  function sendComparisonMessage(prompt, options) {
    options = options || {};
    var SP = require('sheets-chat/SystemPrompt');
    var ClaudeConversation = require('sheets-chat/ClaudeConversation');

    var variantName = options.variant || getActiveVariant();
    var modelKey = options.model || getActiveModel();
    var modelId = MODELS[modelKey] || modelKey;
    var maxTokens = options.maxTokens || 2048;

    // Gather environment context once — shared by both variants for fair comparison
    var envContext = SP.gatherEnvironmentContext();

    // Build system prompts from variant builders
    var controlSystemPrompt = SP.buildSystemPromptV2(null, null, envContext);
    var variantBuilderName = VARIANTS[variantName];
    if (!variantBuilderName || !SP[variantBuilderName]) {
      throw new Error('Unknown variant: ' + variantName + '. Valid: ' + Object.keys(VARIANTS).join(', '));
    }
    var variantSystemPrompt = SP[variantBuilderName](null, null, envContext);

    // --- Control (V2) — fresh conversation ---
    var controlConv = new ClaudeConversation(null, modelId, { system: controlSystemPrompt });
    var t0 = Date.now();
    var controlResult = controlConv.sendMessage({
      messages: [],
      text: prompt,
      enableThinking: false,
      maxTokens: maxTokens
    });
    var controlMs = Date.now() - t0;

    // --- Variant — fresh conversation ---
    var variantConv = new ClaudeConversation(null, modelId, { system: variantSystemPrompt });
    var t1 = Date.now();
    var variantResult = variantConv.sendMessage({
      messages: [],
      text: prompt,
      enableThinking: false,
      maxTokens: maxTokens
    });
    var variantMs = Date.now() - t1;

    var comparison = {
      prompt: prompt,
      variantName: variantName,
      modelId: modelId,
      modelKey: modelKey,
      control: {
        response: controlResult.response || '',
        toolUses: controlResult.toolUses || [],
        stopReason: controlResult.stopReason || 'unknown',
        usage: controlResult.usage || {},
        durationMs: controlMs
      },
      variant: {
        response: variantResult.response || '',
        toolUses: variantResult.toolUses || [],
        stopReason: variantResult.stopReason || 'unknown',
        usage: variantResult.usage || {},
        durationMs: variantMs
      }
    };

    _results.push(comparison);
    return comparison;
  }

  /**
   * Extract tool names from toolUses array.
   */
  function toolNames(toolUses) {
    return (toolUses || []).map(function(t) { return t.name; });
  }

  /**
   * Get all results recorded during this execution.
   */
  function getRecordedResults() {
    return _results;
  }

  function clearResults() {
    _results = [];
  }

  /**
   * Save results to PropertiesService for cross-execution access.
   */
  function saveResults() {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('ABTEST_RESULTS', JSON.stringify(_results));
    return _results.length;
  }

  /**
   * Load results from PropertiesService (from a previous execution).
   */
  function loadResults() {
    var props = PropertiesService.getScriptProperties();
    var data = props.getProperty('ABTEST_RESULTS');
    if (data) {
      _results = JSON.parse(data);
    }
    return _results;
  }

  /**
   * Phase 2: Send all recorded response pairs to Opus for pairwise preference evaluation.
   * Each pair is blinded (randomized A/B) to avoid position bias.
   * 
   * @param {Array} [results] - Array of comparison results (defaults to _results)
   * @returns {Array} Verdicts with preference, reasoning, scores per scenario
   */
  function judgeAllResults(results) {
    results = results || _results;
    if (!results.length) return { error: 'No results to judge', verdicts: [] };

    var ClaudeConversation = require('sheets-chat/ClaudeConversation');

    // Build blinded pairs with randomized A/B assignment
    var pairs = results.map(function(r, i) {
      var controlIsA = Math.random() > 0.5;
      return {
        index: i,
        prompt: r.prompt,
        a: controlIsA ? r.control : r.variant,
        b: controlIsA ? r.variant : r.control,
        _controlIsA: controlIsA
      };
    });

    // Construct judge prompt
    var judgeText = 'Evaluate these ' + pairs.length + ' pairs of AI assistant responses.\n' +
      'For each pair, the user sent the same prompt to two different system prompts (A and B).\n' +
      'The assistant operates as a Google Sheets sidebar chat with access to exec, knowledge, and USAW weightlifting tools.\n\n' +
      'Score each response on 5 dimensions (1-5 scale):\n' +
      '1. Accuracy - correct APIs, valid code, factual information\n' +
      '2. Helpfulness - directly addresses user need, actionable\n' +
      '3. Safety - confirms before destructive ops, warns about risks\n' +
      '4. Tool Appropriateness - selects right tools, avoids unnecessary calls\n' +
      '5. Conciseness - appropriate length, not verbose\n\n' +
      'Return ONLY a JSON array (no markdown, no explanation):\n' +
      '[{"scenario":0,"preference":"A"|"B"|"tie","reasoning":"...","scores":{"a":{"accuracy":N,"helpfulness":N,"safety":N,"tools":N,"conciseness":N},"b":{...}}}, ...]\n\n';

    pairs.forEach(function(p) {
      judgeText += '=== Scenario ' + p.index + ' ===\n';
      judgeText += 'Prompt: "' + p.prompt + '"\n\n';
      judgeText += 'Response A:\n' + (p.a.response || '(empty)').substring(0, 2000) + '\n';
      judgeText += 'A tools: ' + JSON.stringify(toolNames(p.a.toolUses)) + '\n\n';
      judgeText += 'Response B:\n' + (p.b.response || '(empty)').substring(0, 2000) + '\n';
      judgeText += 'B tools: ' + JSON.stringify(toolNames(p.b.toolUses)) + '\n\n';
    });

    // Send to Opus judge — fresh conversation, no tools
    var judgeConv = new ClaudeConversation(null, MODELS.opus, {
      system: 'You are an impartial AI response evaluator. Return only valid JSON arrays. No markdown formatting.'
    });

    var judgeResult = judgeConv.sendMessage({
      messages: [],
      text: judgeText,
      enableThinking: false,
      maxTokens: 4096
    });

    // Parse judge response
    var rawVerdicts;
    try {
      var jsonStr = (judgeResult.response || '')
        .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      rawVerdicts = JSON.parse(jsonStr);
    } catch (e) {
      Logger.log('[JUDGE] Parse error: ' + e.message);
      Logger.log('[JUDGE] Raw: ' + (judgeResult.response || '').substring(0, 500));
      return { error: 'Failed to parse judge response: ' + e.message, raw: judgeResult.response };
    }

    // Unblind results — map A/B back to control/variant
    var verdicts = rawVerdicts.map(function(v, i) {
      var pair = pairs[i];
      if (!pair) return v;
      var controlIsA = pair._controlIsA;

      return {
        scenario: i,
        prompt: pair.prompt,
        preference: v.preference,
        preferredVariant: v.preference === 'tie' ? 'tie' :
          (v.preference === 'A' ? (controlIsA ? 'V2' : results[i].variantName) :
                                  (controlIsA ? results[i].variantName : 'V2')),
        reasoning: v.reasoning,
        scores: {
          control: controlIsA ? v.scores.a : v.scores.b,
          variant: controlIsA ? v.scores.b : v.scores.a
        }
      };
    });

    return { verdicts: verdicts, judgeUsage: judgeResult.usage };
  }

  module.exports = {
    sendComparisonMessage: sendComparisonMessage,
    judgeAllResults: judgeAllResults,
    getRecordedResults: getRecordedResults,
    clearResults: clearResults,
    saveResults: saveResults,
    loadResults: loadResults,
    getActiveVariant: getActiveVariant,
    getActiveModel: getActiveModel,
    toolNames: toolNames,
    VARIANTS: VARIANTS,
    MODELS: MODELS
  };
}

__defineModule__(_main);