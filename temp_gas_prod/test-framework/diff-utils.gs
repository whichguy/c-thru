function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * diff-utils.gs - Structural diff computation for LLM-friendly test reports
 *
 * Provides deep object/array comparison with detailed diff output
 * for debugging test failures.
 */

/**
 * Safely stringify a value with truncation for large objects
 * @param {*} value - Value to stringify
 * @param {number} maxLength - Maximum string length (default 500)
 * @returns {string} JSON string representation
 */
function safeStringify(value, maxLength) {
  maxLength = maxLength || 500;

  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return '[Function]';

  try {
    const seen = new WeakSet();
    const str = JSON.stringify(value, function(key, val) {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    }, 2);

    if (str && str.length > maxLength) {
      return str.substring(0, maxLength) + '... [truncated]';
    }
    return str;
  } catch (e) {
    return `[Unstringifiable: ${e.message}]`;
  }
}

/**
 * Detect the type of value for diff purposes
 * @param {*} actual - Actual value
 * @param {*} expected - Expected value
 * @returns {string} Type identifier
 */
function detectType(actual, expected) {
  if (Array.isArray(expected) || Array.isArray(actual)) return 'array';
  if ((typeof expected === 'object' && expected !== null) ||
      (typeof actual === 'object' && actual !== null)) return 'object';
  return 'primitive';
}

/**
 * Detect common key fields for array item matching
 * @param {Array} arr - Array to analyze
 * @returns {string|null} Key field name or null
 */
function detectKeyField(arr) {
  if (!arr || !arr.length) return null;
  var sample = arr[0];
  if (typeof sample !== 'object' || sample === null) return null;

  var keyFields = ['id', 'athleteId', 'name', 'key', '_id', 'memberId'];
  for (var i = 0; i < keyFields.length; i++) {
    if (keyFields[i] in sample) return keyFields[i];
  }
  return null;
}

/**
 * Find matching item in array by key field
 * @param {Array} arr - Array to search
 * @param {Object} item - Item to find
 * @param {string} keyField - Field to match on
 * @returns {Object|null} Matching item or null
 */
function findMatch(arr, item, keyField) {
  if (!arr || !keyField) return null;

  for (var i = 0; i < arr.length; i++) {
    if (arr[i] && arr[i][keyField] === item[keyField]) {
      return arr[i];
    }
  }
  return null;
}

/**
 * Find items that exist in both arrays but have different values
 * @param {Array} actual - Actual array
 * @param {Array} expected - Expected array
 * @param {string} keyField - Field to match on
 * @returns {Array} Modified items with before/after values
 */
function findModified(actual, expected, keyField) {
  if (!keyField) return [];

  var modified = [];
  for (var i = 0; i < expected.length; i++) {
    var expectedItem = expected[i];
    var actualItem = findMatch(actual, expectedItem, keyField);

    if (actualItem && !deepEqual(actualItem, expectedItem)) {
      modified.push({
        key: expectedItem[keyField],
        expected: expectedItem,
        actual: actualItem,
        diff: computeDiff(actualItem, expectedItem)
      });
    }
  }
  return modified;
}

/**
 * Deep equality check with circular reference protection
 * @param {*} a - First value
 * @param {*} b - Second value
 * @param {WeakMap} visitedA - Visited objects from a (for circular ref detection)
 * @param {WeakMap} visitedB - Visited objects from b (for circular ref detection)
 * @returns {boolean} True if deeply equal
 */
function deepEqual(a, b, visitedA, visitedB) {
  // Initialize visited maps on first call
  if (!visitedA) {
    visitedA = new WeakMap();
    visitedB = new WeakMap();
  }

  // Primitive comparison
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  // Check for circular references
  if (visitedA.has(a)) {
    // If we've seen 'a' before, check if 'b' was seen at the same position
    return visitedB.has(b) && visitedA.get(a) === visitedB.get(b);
  }

  // Mark as visited with a unique ID
  var visitId = visitedA.size || 0;
  visitedA.set(a, visitId);
  visitedB.set(b, visitId);

  // Array comparison
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], visitedA, visitedB)) return false;
    }
    return true;
  }

  // Object comparison
  var keysA = Object.keys(a);
  var keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (var j = 0; j < keysA.length; j++) {
    var key = keysA[j];
    if (!(key in b)) return false;
    if (!deepEqual(a[key], b[key], visitedA, visitedB)) return false;
  }

  return true;
}

/**
 * Compute structural diff between actual and expected values
 * @param {*} actual - Actual value
 * @param {*} expected - Expected value
 * @returns {Object} Diff object with type, changes, and summary
 */
function computeDiff(actual, expected) {
  var diff = {
    type: detectType(actual, expected),
    changes: [],
    summary: ''
  };

  // Handle null/undefined cases
  if (actual === null || actual === undefined) {
    diff.summary = `Actual is ${String(actual)}, expected ${safeStringify(expected, 100)}`;
    return diff;
  }

  if (expected === null || expected === undefined) {
    diff.summary = `Expected is ${String(expected)}, got ${safeStringify(actual, 100)}`;
    return diff;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    // ARRAY DIFF
    var actualArr = Array.isArray(actual) ? actual : [];
    var expectedArr = Array.isArray(expected) ? expected : [];

    var keyField = detectKeyField(expectedArr) || detectKeyField(actualArr);
    diff.byKey = keyField;

    if (keyField) {
      // Match by key field
      diff.missing = expectedArr.filter(function(e) {
        return !findMatch(actualArr, e, keyField);
      });
      diff.extra = actualArr.filter(function(a) {
        return !findMatch(expectedArr, a, keyField);
      });
      diff.modified = findModified(actualArr, expectedArr, keyField);
    } else {
      // Match by index
      diff.missing = [];
      diff.extra = [];
      diff.modified = [];

      var maxLen = Math.max(actualArr.length, expectedArr.length);
      for (var i = 0; i < maxLen; i++) {
        if (i >= expectedArr.length) {
          diff.extra.push({ index: i, value: actualArr[i] });
        } else if (i >= actualArr.length) {
          diff.missing.push({ index: i, value: expectedArr[i] });
        } else if (!deepEqual(actualArr[i], expectedArr[i])) {
          diff.modified.push({
            index: i,
            expected: expectedArr[i],
            actual: actualArr[i]
          });
        }
      }
    }

    var parts = [];
    if (diff.missing.length) parts.push(`Missing: ${diff.missing.length}`);
    if (diff.extra.length) parts.push(`Extra: ${diff.extra.length}`);
    if (diff.modified.length) parts.push(`Modified: ${diff.modified.length}`);
    diff.summary = parts.join(', ') || 'Arrays equal';

  } else if (typeof expected === 'object' && expected !== null) {
    // OBJECT DIFF
    diff.added = [];
    diff.removed = [];
    diff.modified = [];

    var actualObj = (typeof actual === 'object' && actual !== null) ? actual : {};
    var allKeys = {};

    Object.keys(actualObj).forEach(function(k) { allKeys[k] = true; });
    Object.keys(expected).forEach(function(k) { allKeys[k] = true; });

    Object.keys(allKeys).forEach(function(key) {
      if (!(key in expected)) {
        diff.added.push({ key: key, value: actualObj[key] });
      } else if (!(key in actualObj)) {
        diff.removed.push({ key: key, value: expected[key] });
      } else if (!deepEqual(actualObj[key], expected[key])) {
        diff.modified.push({
          key: key,
          expected: expected[key],
          actual: actualObj[key],
          nestedDiff: computeDiff(actualObj[key], expected[key])
        });
      }
    });

    diff.summary = `+${diff.added.length} -${diff.removed.length} ~${diff.modified.length}`;

  } else {
    // PRIMITIVE DIFF
    diff.expected = expected;
    diff.actual = actual;
    diff.summary = `${safeStringify(actual, 50)} ≠ ${safeStringify(expected, 50)}`;
  }

  return diff;
}

/**
 * Format diff for human-readable output
 * @param {Object} diff - Diff object from computeDiff
 * @param {number} indent - Indentation level
 * @returns {string} Formatted diff string
 */
function formatDiff(diff, indent) {
  indent = indent || 0;
  var pad = '  '.repeat(indent);
  var lines = [];

  if (diff.type === 'array') {
    if (diff.missing && diff.missing.length) {
      lines.push(`${pad}MISSING (${diff.missing.length}):`);
      diff.missing.slice(0, 5).forEach(function(item) {
        var display = diff.byKey ? item[diff.byKey] : safeStringify(item, 80);
        lines.push(`${pad}  - ${display}`);
      });
      if (diff.missing.length > 5) {
        lines.push(`${pad}  ... and ${diff.missing.length - 5} more`);
      }
    }

    if (diff.extra && diff.extra.length) {
      lines.push(`${pad}EXTRA (${diff.extra.length}):`);
      diff.extra.slice(0, 5).forEach(function(item) {
        var display = diff.byKey ? item[diff.byKey] : safeStringify(item, 80);
        lines.push(`${pad}  + ${display}`);
      });
      if (diff.extra.length > 5) {
        lines.push(`${pad}  ... and ${diff.extra.length - 5} more`);
      }
    }

    if (diff.modified && diff.modified.length) {
      lines.push(`${pad}MODIFIED (${diff.modified.length}):`);
      diff.modified.slice(0, 3).forEach(function(mod) {
        var key = mod.key || mod.index;
        lines.push(`${pad}  ~ ${key}:`);
        lines.push(`${pad}      expected: ${safeStringify(mod.expected, 60)}`);
        lines.push(`${pad}      actual:   ${safeStringify(mod.actual, 60)}`);
      });
    }

  } else if (diff.type === 'object') {
    if (diff.removed && diff.removed.length) {
      lines.push(`${pad}MISSING KEYS:`);
      diff.removed.forEach(function(item) {
        lines.push(`${pad}  - ${item.key}: ${safeStringify(item.value, 50)}`);
      });
    }

    if (diff.added && diff.added.length) {
      lines.push(`${pad}EXTRA KEYS:`);
      diff.added.forEach(function(item) {
        lines.push(`${pad}  + ${item.key}: ${safeStringify(item.value, 50)}`);
      });
    }

    if (diff.modified && diff.modified.length) {
      lines.push(`${pad}MODIFIED:`);
      diff.modified.forEach(function(mod) {
        lines.push(`${pad}  ~ ${mod.key}:`);
        lines.push(`${pad}      expected: ${safeStringify(mod.expected, 50)}`);
        lines.push(`${pad}      actual:   ${safeStringify(mod.actual, 50)}`);
      });
    }

  } else {
    lines.push(`${pad}Expected: ${safeStringify(diff.expected, 100)}`);
    lines.push(`${pad}Actual:   ${safeStringify(diff.actual, 100)}`);
  }

  return lines.join('\n');
}

// Export for CommonJS
if (typeof module !== 'undefined') {
  module.exports = {
    safeStringify: safeStringify,
    detectType: detectType,
    detectKeyField: detectKeyField,
    findMatch: findMatch,
    findModified: findModified,
    deepEqual: deepEqual,
    computeDiff: computeDiff,
    formatDiff: formatDiff
  };
}
}
__defineModule__(_main);
