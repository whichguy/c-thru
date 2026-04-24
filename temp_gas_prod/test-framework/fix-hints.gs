function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * fix-hints.gs - Auto-generated debugging hints for test failures
 *
 * Analyzes diff results and generates actionable fix suggestions
 * for LLM-assisted debugging.
 */

/**
 * Generate fix hints based on llmReport data
 * @param {Object} llmReport - The llmReport object from assertion error
 * @returns {Array<string>} Array of hint strings
 */
function generateFixHints(llmReport) {
  var hints = [];

  if (!llmReport) return hints;

  var diff = llmReport.diff;
  var values = llmReport.values;

  // RULE: Type mismatch
  if (values && values.actualType !== values.expectedType) {
    hints.push('TYPE MISMATCH: expected ' + values.expectedType + ', got ' + values.actualType);
  }

  // RULE: Null/undefined actual
  if (values && (values.actual === null || values.actual === undefined)) {
    hints.push('ACTUAL IS ' + String(values.actual) + ' - check function return value or data loading');
  }

  // RULE: Empty array returned
  if (values && Array.isArray(values.actual) && values.actual.length === 0) {
    if (values.expected && values.expected.length > 0) {
      hints.push('EMPTY ARRAY returned - check filter conditions, data source, or date range');
    }
  }

  if (!diff) return hints;

  // RULE: Missing array items
  if (diff.missing && diff.missing.length) {
    var keyField = diff.byKey || 'item';
    diff.missing.slice(0, 5).forEach(function(item) {
      var identifier = item[keyField] || JSON.stringify(item).slice(0, 50);
      hints.push('MISSING: "' + identifier + '" - check filter/selection criteria');
    });
    if (diff.missing.length > 5) {
      hints.push('... and ' + (diff.missing.length - 5) + ' more missing items');
    }
  }

  // RULE: Extra unexpected items
  if (diff.extra && diff.extra.length) {
    diff.extra.slice(0, 5).forEach(function(item) {
      var keyField = diff.byKey || 'item';
      var identifier = item[keyField] || JSON.stringify(item).slice(0, 50);
      hints.push('UNEXPECTED: "' + identifier + '" - check why this passed filters');
    });
    if (diff.extra.length > 5) {
      hints.push('... and ' + (diff.extra.length - 5) + ' more unexpected items');
    }
  }

  // RULE: Property value mismatch
  if (diff.modified && diff.modified.length) {
    diff.modified.slice(0, 5).forEach(function(mod) {
      var key = mod.key || mod.index;
      hints.push('MISMATCH at "' + key + '": expected ' +
        JSON.stringify(mod.expected).slice(0, 30) + ', got ' +
        JSON.stringify(mod.actual).slice(0, 30));
    });
  }

  // RULE: Object key differences
  if (diff.removed && diff.removed.length) {
    diff.removed.forEach(function(item) {
      hints.push('MISSING KEY: "' + item.key + '" not found in actual object');
    });
  }

  if (diff.added && diff.added.length) {
    diff.added.forEach(function(item) {
      hints.push('EXTRA KEY: "' + item.key + '" not expected in result');
    });
  }

  return hints;
}

/**
 * Generate domain-specific hints for NTP/USAW testing
 * @param {Object} llmReport - The llmReport object
 * @param {Object} context - Test context with domain info
 * @returns {Array<string>} Domain-specific hints
 */
function generateDomainHints(llmReport, context) {
  var hints = [];

  if (!context || !context.domain) return hints;

  var diff = llmReport && llmReport.diff;

  if (context.domain === 'ntp' || context.domain === 'usaw') {
    // NTP-specific hints
    if (diff && diff.missing && diff.missing.length) {
      diff.missing.forEach(function(athlete) {
        if (athlete.name) {
          hints.push('Check if "' + athlete.name + '" meets tier criteria:');
          hints.push('  - Verify qualifying period dates');
          hints.push('  - Check eventType classification');
          hints.push('  - Verify US citizenship/eligibility');
        }
      });
    }

    // Check for date-related issues
    if (context.qualifyingPeriod) {
      hints.push('Qualifying period: ' + context.qualifyingPeriod);
    }

    if (context.standardsYear) {
      hints.push('Standards year: ' + context.standardsYear);
    }
  }

  return hints;
}

/**
 * Format hints for display
 * @param {Array<string>} hints - Array of hint strings
 * @returns {string} Formatted hints block
 */
function formatHints(hints) {
  if (!hints || !hints.length) return '';

  var lines = ['FIX HINTS:'];
  hints.forEach(function(hint) {
    lines.push('  → ' + hint);
  });
  return lines.join('\n');
}

/**
 * Combine all hint sources into final hint list
 * @param {Object} llmReport - The llmReport object
 * @param {Object} context - Test context
 * @returns {Array<string>} Combined hints
 */
function getAllHints(llmReport, context) {
  var baseHints = generateFixHints(llmReport);
  var domainHints = generateDomainHints(llmReport, context);

  // Add context hints if available
  if (context && context.hints) {
    baseHints = baseHints.concat(context.hints);
  }

  return baseHints.concat(domainHints);
}

// Export for CommonJS
if (typeof module !== 'undefined') {
  module.exports = {
    generateFixHints: generateFixHints,
    generateDomainHints: generateDomainHints,
    formatHints: formatHints,
    getAllHints: getAllHints
  };
}
}
__defineModule__(_main);
