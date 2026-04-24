function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * chai-assertions.gs - Chai-style assertions with LLM-friendly error reports
 *
 * Provides expect() and assert APIs with structured error reporting
 * for AI-assisted debugging.
 */

var diffUtils = require('test-framework/diff-utils');

/**
 * Deep equality comparison with circular reference detection
 */
function deepEqual(a, b, visitedA, visitedB) {
  if (!visitedA) {
    visitedA = new WeakMap();
    visitedB = new WeakMap();
  }

  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (visitedA.has(a)) {
      return visitedB.has(b) && visitedA.get(a) === visitedB.get(b);
    }

    var idA = visitedA.size;
    visitedA.set(a, idA);
    visitedB.set(b, idA);

    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], visitedA, visitedB)) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    if (visitedA.has(a)) {
      return visitedB.has(b) && visitedA.get(a) === visitedB.get(b);
    }

    var idA = visitedA.size;
    visitedA.set(a, idA);
    visitedB.set(b, idA);

    var keysA = Object.keys(a);
    var keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (var j = 0; j < keysA.length; j++) {
      var key = keysA[j];
      if (keysB.indexOf(key) === -1) return false;
      if (!deepEqual(a[key], b[key], visitedA, visitedB)) return false;
    }

    return true;
  }

  return false;
}

/**
 * Assertion class with LLM-friendly error reporting
 */
function Assertion(actual) {
  this.actual = actual;
  this.negated = false;
  this.useDeepEqual = false;
  this._chainedMethods = [];
  this._assertionType = null;
}

/**
 * Build an error with llmReport attached
 */
Assertion.prototype._buildError = function(message, expected, assertionType) {
  var error = new Error(message);

  error.llmReport = {
    assertion: {
      type: assertionType || this._assertionType,
      method: this._chainedMethods.join('.'),
      negated: this.negated
    },
    values: {
      actual: this.actual,
      actualType: typeof this.actual,
      actualJSON: diffUtils.safeStringify(this.actual, 500),
      expected: expected,
      expectedType: typeof expected,
      expectedJSON: diffUtils.safeStringify(expected, 500)
    },
    diff: diffUtils.computeDiff(this.actual, expected)
  };

  return error;
};

/**
 * Track chained method
 */
Assertion.prototype._track = function(method) {
  this._chainedMethods.push(method);
  return this;
};

// Getter for 'not' - negates the assertion
Object.defineProperty(Assertion.prototype, 'not', {
  get: function() {
    this.negated = !this.negated;
    return this._track('not');
  }
});

// Syntactic sugar getters
Object.defineProperty(Assertion.prototype, 'to', {
  get: function() { return this._track('to'); }
});

Object.defineProperty(Assertion.prototype, 'be', {
  get: function() { return this._track('be'); }
});

Object.defineProperty(Assertion.prototype, 'been', {
  get: function() { return this._track('been'); }
});

Object.defineProperty(Assertion.prototype, 'have', {
  get: function() { return this._track('have'); }
});

Object.defineProperty(Assertion.prototype, 'deep', {
  get: function() {
    this.useDeepEqual = true;
    return this._track('deep');
  }
});

/**
 * Assert equality
 */
Assertion.prototype.equal = function(expected, message) {
  this._assertionType = this.useDeepEqual ? 'deep.equal' : 'equal';
  this._track('equal');

  var isEqual = this.useDeepEqual
    ? deepEqual(this.actual, expected)
    : this.actual === expected;

  var passes = this.negated ? !isEqual : isEqual;

  if (!passes) {
    var actualStr = JSON.stringify(this.actual);
    var expectedStr = JSON.stringify(expected);
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + actualStr + ' to ' + notStr + 'equal ' + expectedStr + customMsg,
      expected,
      this._assertionType
    );
  }
};

// Alias for equal
Assertion.prototype.equals = Assertion.prototype.equal;
Assertion.prototype.eql = function(expected, message) {
  this.useDeepEqual = true;
  return this.equal(expected, message);
};

/**
 * Assert boolean true
 */
Object.defineProperty(Assertion.prototype, 'true', {
  get: function() {
    this._assertionType = 'true';
    var passes = this.negated ? this.actual !== true : this.actual === true;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be true',
        true,
        'true'
      );
    }
    return this;
  }
});

/**
 * Assert boolean false
 */
Object.defineProperty(Assertion.prototype, 'false', {
  get: function() {
    this._assertionType = 'false';
    var passes = this.negated ? this.actual !== false : this.actual === false;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be false',
        false,
        'false'
      );
    }
    return this;
  }
});

/**
 * Assert null
 */
Object.defineProperty(Assertion.prototype, 'null', {
  get: function() {
    this._assertionType = 'null';
    var passes = this.negated ? this.actual !== null : this.actual === null;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be null',
        null,
        'null'
      );
    }
    return this;
  }
});

/**
 * Assert undefined
 */
Object.defineProperty(Assertion.prototype, 'undefined', {
  get: function() {
    this._assertionType = 'undefined';
    var passes = this.negated ? this.actual !== undefined : this.actual === undefined;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be undefined',
        undefined,
        'undefined'
      );
    }
    return this;
  }
});

/**
 * Assert existence (not null and not undefined)
 */
Object.defineProperty(Assertion.prototype, 'exist', {
  get: function() {
    this._assertionType = 'exist';
    var exists = this.actual !== null && this.actual !== undefined;
    var passes = this.negated ? !exists : exists;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'exist',
        this.negated ? null : 'defined value',
        'exist'
      );
    }
    return this;
  }
});

/**
 * Assert empty (string, array, or object)
 */
Object.defineProperty(Assertion.prototype, 'empty', {
  get: function() {
    this._assertionType = 'empty';
    var isEmpty;

    if (typeof this.actual === 'string' || Array.isArray(this.actual)) {
      isEmpty = this.actual.length === 0;
    } else if (typeof this.actual === 'object' && this.actual !== null) {
      isEmpty = Object.keys(this.actual).length === 0;
    } else {
      throw new Error('Expected string, array, or object');
    }

    var passes = this.negated ? !isEmpty : isEmpty;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be empty',
        this.negated ? this.actual : [],
        'empty'
      );
    }
    return this;
  }
});

/**
 * Assert array/string length
 */
Assertion.prototype.length = function(expected, message) {
  this._assertionType = 'length';
  this._track('length');

  if (typeof this.actual !== 'string' && !Array.isArray(this.actual)) {
    throw new Error('Expected string or array');
  }

  var passes = this.negated
    ? this.actual.length !== expected
    : this.actual.length === expected;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'have length ' + expected + customMsg,
      expected,
      'length'
    );
  }
};

// lengthOf alias
Assertion.prototype.lengthOf = Assertion.prototype.length;

/**
 * Assert array/string includes value
 */
Assertion.prototype.include = function(value, message) {
  this._assertionType = 'include';
  this._track('include');

  var includes;

  if (typeof this.actual === 'string') {
    includes = this.actual.indexOf(value) !== -1;
  } else if (Array.isArray(this.actual)) {
    includes = this.actual.some(function(item) { return deepEqual(item, value); });
  } else if (typeof this.actual === 'object' && this.actual !== null) {
    var keys = Object.keys(this.actual);
    var self = this;
    includes = keys.some(function(k) { return deepEqual(self.actual[k], value); });
  } else {
    throw new Error('Expected string, array, or object');
  }

  var passes = this.negated ? !includes : includes;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'include ' + JSON.stringify(value) + customMsg,
      value,
      'include'
    );
  }
};

// Alias
Assertion.prototype.includes = Assertion.prototype.include;
Assertion.prototype.contain = Assertion.prototype.include;
Assertion.prototype.contains = Assertion.prototype.include;

/**
 * Assert object has property
 */
Assertion.prototype.property = function(property, value, message) {
  this._assertionType = 'property';
  this._track('property');

  if (typeof this.actual !== 'object' || this.actual === null) {
    throw new Error('Expected object');
  }

  if (!property) {
    throw new Error('Property name required');
  }

  var hasProperty = property in this.actual;

  if (arguments.length === 1) {
    var passes = this.negated ? !hasProperty : hasProperty;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected object to ' + notStr + "have property '" + property + "'",
        property,
        'property'
      );
    }
  } else {
    if (!hasProperty) {
      throw this._buildError(
        "Expected object to have property '" + property + "'",
        property,
        'property'
      );
    }

    var valueMatches = deepEqual(this.actual[property], value);
    var passes = this.negated ? !valueMatches : valueMatches;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      var customMsg = message ? ': ' + message : '';
      throw this._buildError(
        "Expected property '" + property + "' to " + notStr + 'equal ' + JSON.stringify(value) + customMsg,
        value,
        'property'
      );
    }
  }
};

/**
 * Assert function throws error
 */
Assertion.prototype.throw = function(errorMatch, message) {
  this._assertionType = 'throw';
  this._track('throw');

  if (typeof this.actual !== 'function') {
    throw new Error('Expected function');
  }

  var thrown = false;
  var error = null;

  try {
    this.actual();
  } catch (e) {
    thrown = true;
    error = e;
  }

  var passes = this.negated ? !thrown : thrown;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected function to ' + notStr + 'throw' + customMsg,
      'Error',
      'throw'
    );
  }

  if (thrown && errorMatch && !this.negated) {
    var errorMessage = error.message || String(error);
    var matches;

    if (errorMatch instanceof RegExp) {
      matches = errorMatch.test(errorMessage);
    } else {
      matches = errorMessage.indexOf(String(errorMatch)) !== -1;
    }

    if (!matches) {
      throw this._buildError(
        "Expected error message '" + errorMessage + "' to match " + errorMatch,
        errorMatch,
        'throw'
      );
    }
  }
};

// Alias
Assertion.prototype.throws = Assertion.prototype.throw;

/**
 * Assert greater than
 */
Assertion.prototype.greaterThan = function(expected, message) {
  this._assertionType = 'greaterThan';
  this._track('greaterThan');

  var passes = this.negated ? !(this.actual > expected) : this.actual > expected;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + this.actual + ' to ' + notStr + 'be greater than ' + expected + customMsg,
      expected,
      'greaterThan'
    );
  }
};

// Aliases
Assertion.prototype.above = Assertion.prototype.greaterThan;
Assertion.prototype.gt = Assertion.prototype.greaterThan;

/**
 * Assert less than
 */
Assertion.prototype.lessThan = function(expected, message) {
  this._assertionType = 'lessThan';
  this._track('lessThan');

  var passes = this.negated ? !(this.actual < expected) : this.actual < expected;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + this.actual + ' to ' + notStr + 'be less than ' + expected + customMsg,
      expected,
      'lessThan'
    );
  }
};

// Aliases
Assertion.prototype.below = Assertion.prototype.lessThan;
Assertion.prototype.lt = Assertion.prototype.lessThan;

/**
 * Assert at least (>=)
 */
Assertion.prototype.least = function(expected, message) {
  this._assertionType = 'least';
  this._track('least');

  var passes = this.negated ? !(this.actual >= expected) : this.actual >= expected;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + this.actual + ' to ' + notStr + 'be at least ' + expected + customMsg,
      expected,
      'least'
    );
  }
};

// Aliases
Assertion.prototype.gte = Assertion.prototype.least;

/**
 * Assert at most (<=)
 */
Assertion.prototype.most = function(expected, message) {
  this._assertionType = 'most';
  this._track('most');

  var passes = this.negated ? !(this.actual <= expected) : this.actual <= expected;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + this.actual + ' to ' + notStr + 'be at most ' + expected + customMsg,
      expected,
      'most'
    );
  }
};

// Aliases
Assertion.prototype.lte = Assertion.prototype.most;

/**
 * Assert value is one of the expected values
 */
Assertion.prototype.oneOf = function(list, message) {
  this._assertionType = 'oneOf';
  this._track('oneOf');

  if (!Array.isArray(list)) {
    throw new Error('Expected array for oneOf assertion');
  }

  var self = this;
  var isOneOf = list.some(function(item) { return deepEqual(self.actual, item); });
  var passes = this.negated ? !isOneOf : isOneOf;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be one of ' + JSON.stringify(list) + customMsg,
      list,
      'oneOf'
    );
  }
};

/**
 * Assert type using typeof or instanceof
 */
Assertion.prototype.an = function(expectedType, message) {
  this._assertionType = 'type';
  this._track('an');

  var typeMatches;
  var lowerType = expectedType.toLowerCase();

  if (lowerType === 'array') {
    typeMatches = Array.isArray(this.actual);
  } else if (lowerType === 'object') {
    typeMatches = typeof this.actual === 'object' && this.actual !== null && !Array.isArray(this.actual);
  } else if (lowerType === 'null') {
    typeMatches = this.actual === null;
  } else {
    typeMatches = typeof this.actual === lowerType;
  }

  var passes = this.negated ? !typeMatches : typeMatches;

  if (!passes) {
    var notStr = this.negated ? 'not ' : '';
    var customMsg = message ? ': ' + message : '';
    throw this._buildError(
      'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be ' + expectedType + customMsg,
      expectedType,
      'type'
    );
  }
};

// Alias
Assertion.prototype.a = Assertion.prototype.an;

/**
 * Assert truthy value
 */
Object.defineProperty(Assertion.prototype, 'ok', {
  get: function() {
    this._assertionType = 'ok';
    var passes = this.negated ? !this.actual : !!this.actual;

    if (!passes) {
      var notStr = this.negated ? 'not ' : '';
      throw this._buildError(
        'Expected ' + JSON.stringify(this.actual) + ' to ' + notStr + 'be ok (truthy)',
        true,
        'ok'
      );
    }
    return this;
  }
});

/**
 * Create an expectation assertion
 */
function expect(actual) {
  return new Assertion(actual);
}

/**
 * Traditional assert-style assertions
 */
var assert = {
  ok: function(value, message) {
    if (!value) {
      throw new Error(message || 'Expected ' + JSON.stringify(value) + ' to be truthy');
    }
  },

  equal: function(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        message || 'Expected ' + JSON.stringify(actual) + ' to equal ' + JSON.stringify(expected)
      );
    }
  },

  deepEqual: function(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      throw new Error(
        message || 'Expected ' + JSON.stringify(actual) + ' to deeply equal ' + JSON.stringify(expected)
      );
    }
  },

  strictEqual: function(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        message || 'Expected ' + JSON.stringify(actual) + ' to strictly equal ' + JSON.stringify(expected)
      );
    }
  },

  throws: function(fn, errorMatch, message) {
    var thrown = false;
    var error = null;

    try {
      fn();
    } catch (e) {
      thrown = true;
      error = e;
    }

    if (!thrown) {
      throw new Error(message || 'Expected function to throw');
    }

    if (errorMatch) {
      var errorMessage = error.message || String(error);
      var matches;

      if (errorMatch instanceof RegExp) {
        matches = errorMatch.test(errorMessage);
      } else {
        matches = errorMessage.indexOf(String(errorMatch)) !== -1;
      }

      if (!matches) {
        throw new Error(
          message || "Expected error message '" + errorMessage + "' to match " + errorMatch
        );
      }
    }
  },

  doesNotThrow: function(fn, message) {
    try {
      fn();
    } catch (e) {
      throw new Error(message || 'Expected function not to throw but got: ' + e.message);
    }
  }
};

// Export public API
module.exports = {
  expect: expect,
  assert: assert,
  deepEqual: deepEqual,
  Assertion: Assertion
};
}
__defineModule__(_main);
