function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Filter and combination helpers for USAW tools
   * Handles UNION operations (multiple API calls) and FILTER operations (client-side filtering)
   */

  var Normalizers = require('tools/helpers/UsawNormalizers');

  /**
   * Check if value matches any filter in array (OR logic, partial match)
   * @param {string} value - Value to check
   * @param {Array<string>} filterArray - Array of filter values
   * @return {boolean} True if matches any filter (or filterArray is empty)
   */
  function matchesAny(value, filterArray) {
    if (!filterArray || filterArray.length === 0) return true;
    if (!value) return false;

    var lowerValue = String(value).toLowerCase();
    return filterArray.some(function(filter) {
      var lowerFilter = String(filter).toLowerCase();
      return lowerValue.includes(lowerFilter) || lowerFilter.includes(lowerValue);
    });
  }

  /**
   * Generate Cartesian product of arrays (for UNION combinations)
   * @param {Array<Array>} arrays - Arrays to combine
   * @return {Array<Array>} All combinations
   */
  function cartesianProduct(arrays) {
    // Validate input
    if (!Array.isArray(arrays)) {
      throw new Error('cartesianProduct expects an array, got ' + typeof arrays);
    }
    if (arrays.length === 0) return [[]];
    if (arrays.length === 1) return arrays[0].map(function(v) { return [v]; });

    var result = [[]];
    arrays.forEach(function(arr) {
      var temp = [];
      result.forEach(function(resultItem) {
        arr.forEach(function(arrItem) {
          temp.push(resultItem.concat([arrItem]));
        });
      });
      result = temp;
    });

    return result;
  }

  /**
   * Deduplicate array of objects by key field
   * @param {Array<Object>} array - Array to deduplicate
   * @param {string} keyField - Field to use as unique key (default: 'id')
   * @return {Array<Object>} Deduplicated array
   */
  function deduplicateByKey(array, keyField) {
    // Validate input
    if (!Array.isArray(array)) {
      throw new Error('deduplicateByKey expects an array, got ' + typeof array);
    }
    keyField = keyField || 'id';
    var seen = {};
    return array.filter(function(item) {
      var key = item[keyField] || JSON.stringify(item);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /**
   * Apply filters to result array with logging
   * @param {Array<Object>} results - Results to filter
   * @param {Object} filters - Filter object { wsos: [...], clubs: [...], etc. }
   * @return {Array<Object>} Filtered results
   */
  function applyFilters(results, filters) {
    // Validate input
    if (!Array.isArray(results)) {
      throw new Error('applyFilters expects results array, got ' + typeof results);
    }
    if (!filters || typeof filters !== 'object') {
      return results;  // No filters to apply
    }
    
    var filtered = results;
    var originalCount = results.length;

    if (filters.wsos && filters.wsos.length > 0) {
      var before = filtered.length;
      filtered = filtered.filter(function(r) {
        return matchesAny(r.wso || r.wso_name, filters.wsos);
      });
      thinking('WSO filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.clubs && filters.clubs.length > 0) {
      var before = filtered.length;
      filtered = filtered.filter(function(r) {
        return matchesAny(r.club || r.club_name, filters.clubs);
      });
      thinking('Club filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.athlete_names && filters.athlete_names.length > 0) {
      var before = filtered.length;
      filtered = filtered.filter(function(r) {
        return matchesAny(r.name || r.athlete_name || r.lifter_name, filters.athlete_names);
      });
      thinking('Athlete name filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.states && filters.states.length > 0) {
      var before = filtered.length;
      var normalizedStates = Normalizers.normalizeStates(filters.states);
      filtered = filtered.filter(function(r) {
        return matchesAny(r.state || r.location || r.region, normalizedStates);
      });
      thinking('State filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.gender) {
      var before = filtered.length;
      var normalizedGender = Normalizers.normalizeGender(filters.gender);
      if (normalizedGender) {
        filtered = filtered.filter(function(r) {
          return Normalizers.normalizeGender(r.gender) === normalizedGender;
        });
        thinking('Gender filter: ' + before + ' → ' + filtered.length + ' results');
      }
    }

    if (filters.age_categories && filters.age_categories.length > 0) {
      var before = filtered.length;
      var normalizedCategories = filters.age_categories.map(function(cat) {
        return Normalizers.normalizeAgeCategory(cat);
      });
      filtered = filtered.filter(function(r) {
        var rCat = Normalizers.normalizeAgeCategory(r.age_category || r.category);
        return matchesAny(rCat, normalizedCategories);
      });
      thinking('Age category filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.min_total !== undefined && filters.min_total !== null) {
      var before = filtered.length;
      filtered = filtered.filter(function(r) {
        return (r.total || 0) >= filters.min_total;
      });
      thinking('Min total filter (>=' + filters.min_total + '): ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.max_total !== undefined && filters.max_total !== null) {
      var before = filtered.length;
      filtered = filtered.filter(function(r) {
        return (r.total || 0) <= filters.max_total;
      });
      thinking('Max total filter (<=' + filters.max_total + '): ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.divisions && filters.divisions.length > 0) {
      var before = filtered.length;
      var normalizedDivisions = filters.divisions.map(function(div) {
        return Normalizers.normalizeDivision(div);
      });
      filtered = filtered.filter(function(r) {
        var rDiv = Normalizers.normalizeDivision(r.division);
        return matchesAny(rDiv, normalizedDivisions);
      });
      thinking('Division filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (filters.weight_classes && filters.weight_classes.length > 0) {
      var before = filtered.length;
      var parsedWcs = Normalizers.parseWeightClasses(filters.weight_classes);
      filtered = filtered.filter(function(r) {
        var rWc = Normalizers.parseWeightClass(r.weight_class || r.wc);
        return parsedWcs.indexOf(rWc) !== -1;
      });
      thinking('Weight class filter: ' + before + ' → ' + filtered.length + ' results');
    }

    if (originalCount !== filtered.length) {
      thinking('Total filtering: ' + originalCount + ' → ' + filtered.length + ' results');
    }
    
    return filtered;
  }

  /**
   * Sort results by sort specification
   * @param {Array<Object>} results - Results to sort
   * @param {string} sortBy - Sort spec: "field:dir,field2:dir2" (e.g., "total:desc,name:asc")
   * @return {Array<Object>} Sorted results
   */
  function applySorting(results, sortBy) {
    // Validate input
    if (!Array.isArray(results)) {
      throw new Error('applySorting expects results array, got ' + typeof results);
    }
    if (!sortBy) return results;

    var sortSpec = sortBy.split(',').map(function(part) {
      var parts = part.trim().split(':');
      return {
        field: parts[0],
        dir: (parts[1] || 'asc').toLowerCase() === 'desc' ? -1 : 1
      };
    });

    return results.sort(function(a, b) {
      for (var i = 0; i < sortSpec.length; i++) {
        var field = sortSpec[i].field;
        var dir = sortSpec[i].dir;
        var aVal = a[field];
        var bVal = b[field];

        if (aVal == null && bVal == null) continue;
        if (aVal == null) return 1 * dir;
        if (bVal == null) return -1 * dir;

        if (aVal < bVal) return -1 * dir;
        if (aVal > bVal) return 1 * dir;
      }
      return 0;
    });
  }

  /**
   * Apply top_n limit to results
   * @param {Array<Object>} results - Results to limit
   * @param {number} topN - Max results to return (0 = no limit)
   * @return {Array<Object>} Limited results
   */
  function applyTopN(results, topN) {
    // Validate input
    if (!Array.isArray(results)) {
      throw new Error('applyTopN expects results array, got ' + typeof results);
    }
    if (!topN || topN <= 0) return results;
    thinking('Limiting to top ' + topN + ' results (from ' + results.length + ')');
    return results.slice(0, topN);
  }

  /**
   * Estimate and warn about UNION API call count
   * @param {Object} unionParams - Object with arrays of UNION parameter values { param1: [val1, val2], param2: [val3] }
   * @return {number} Estimated API call count
   */
  function estimateAndWarnApiCalls(unionParams) {
    var callCount = 1;
    var factors = [];

    Object.keys(unionParams).forEach(function(key) {
      var arr = unionParams[key];
      if (Array.isArray(arr) && arr.length > 0) {
        callCount *= arr.length;
        factors.push(key + '[' + arr.length + ']');
      }
    });

    if (callCount > 25) {
      thinking('⚠️  WARNING: ' + callCount + ' API calls required (' + factors.join(' × ') + ')');
      thinking('⚠️  This may take ' + Math.ceil(callCount * 0.5) + '-' + Math.ceil(callCount * 2) + ' seconds');
    } else if (callCount > 1) {
      thinking('Executing ' + callCount + ' API calls (' + factors.join(' × ') + ')');
    }

    return callCount;
  }

  /**
   * Execute UNION operations - multiple API calls combined into one result set
   *
   * Supports two modes:
   * 1. Sequential mode (legacy): Uses apiCallFn for sequential execution
   * 2. Batch mode (optimized): Uses buildRequestFn + parseResponseFn for parallel execution via fetchAll
   *
   * @param {Object} config - Configuration object
   * @param {Object} config.unionParams - Object mapping param names to arrays (e.g., { divisions: ['A', 'B'], weights: [55, 61] })
   * @param {Function} config.apiCallFn - [Sequential mode] Function that takes params object and returns results array
   * @param {Function} config.buildRequestFn - [Batch mode] Function that takes params object and returns UrlFetchApp request object
   * @param {Function} config.parseResponseFn - [Batch mode] Function that takes HTTPResponse and returns results array
   * @param {string} config.dedupeKey - Property name to deduplicate by (default: 'id')
   * @return {Object} { success: boolean, results: Array, api_calls_made: number, error?: string, errors?: Array }
   */
  function executeUnion(config) {
    // Validate config
    if (!config || typeof config !== 'object') {
      return {
        success: false,
        error: 'executeUnion requires a config object'
      };
    }

    var unionParams = config.unionParams || {};
    var dedupeKey = config.dedupeKey || 'id';

    // Generate combinations
    var unionArrays = [];
    var paramNames = [];

    Object.keys(unionParams).forEach(function(key) {
      var arr = unionParams[key];
      if (Array.isArray(arr) && arr.length > 0) {
        unionArrays.push(arr);
        paramNames.push(key);
      }
    });

    // If no UNION params, make single call
    if (unionArrays.length === 0) {
      thinking('No UNION parameters - executing single API call');

      // Batch mode with no UNION params
      if (config.buildRequestFn && config.parseResponseFn) {
        var UrlFetchUtils = require('common-js/UrlFetchUtils');
        var request = config.buildRequestFn({});
        var responses = UrlFetchUtils.fetchAllWithRetry([{ url: request.url, options: request }], {
          continueOnError: true,
          maxTotalTimeMs: 60000,
          think: thinking
        });

        if (responses.responses[0].__error) {
          return {
            success: false,
            error: responses.responses[0].__error,
            api_calls_made: 0
          };
        }

        try {
          var results = config.parseResponseFn(responses.responses[0]);
          return {
            success: true,
            results: results,
            api_calls_made: 1
          };
        } catch (e) {
          return {
            success: false,
            error: 'Failed to parse response: ' + e.message,
            api_calls_made: 1
          };
        }
      }

      // Sequential mode with no UNION params
      if (config.apiCallFn && typeof config.apiCallFn === 'function') {
        try {
          var results = config.apiCallFn({});
          return {
            success: true,
            results: results,
            api_calls_made: 1
          };
        } catch (e) {
          return {
            success: false,
            error: e.message,
            api_calls_made: 0
          };
        }
      }

      return {
        success: false,
        error: 'Either apiCallFn or (buildRequestFn + parseResponseFn) is required'
      };
    }

    // Estimate and warn
    estimateAndWarnApiCalls(unionParams);

    var combinations = cartesianProduct(unionArrays);

    // Batch mode: Use fetchAll for parallel execution
    if (config.buildRequestFn && config.parseResponseFn) {
      thinking('Executing UNION in batch mode (' + combinations.length + ' parallel requests)');
      return executeUnionBatch(config, combinations, paramNames, dedupeKey);
    }

    // Sequential mode: Legacy behavior (backward compatible)
    if (config.apiCallFn && typeof config.apiCallFn === 'function') {
      thinking('Executing UNION in sequential mode (' + combinations.length + ' sequential calls)');
      return executeUnionSequential(config, combinations, paramNames, dedupeKey);
    }

    return {
      success: false,
      error: 'Either apiCallFn or (buildRequestFn + parseResponseFn) is required'
    };
  }

  /**
   * Execute UNION in batch mode using fetchAll for parallel requests
   * @private
   */
  function executeUnionBatch(config, combinations, paramNames, dedupeKey) {
    var UrlFetchUtils = require('common-js/UrlFetchUtils');

    // Build all requests upfront
    var requests = combinations.map(function(combo) {
      var params = {};
      for (var j = 0; j < paramNames.length; j++) {
        params[paramNames[j]] = combo[j];
      }
      var request = config.buildRequestFn(params);
      return {
        url: request.url,
        options: {
          method: request.method || 'GET',
          headers: request.headers || {},
          payload: request.payload,
          contentType: request.contentType || 'application/json'
        }
      };
    });

    // Execute all requests in parallel
    var responses = UrlFetchUtils.fetchAllWithRetry(requests, {
      continueOnError: true,
      maxTotalTimeMs: 300000,
      think: thinking
    });

    // Parse responses
    var allResults = [];
    var successCount = 0;
    var errors = [];

    responses.responses.forEach(function(response, idx) {
      if (response.__error) {
        errors.push('Combination ' + (idx + 1) + ': ' + response.__error);
        return;
      }

      try {
        var results = config.parseResponseFn(response);
        allResults = allResults.concat(results);
        successCount++;
      } catch (e) {
        errors.push('Combination ' + (idx + 1) + ': Failed to parse response - ' + e.message);
      }
    });

    thinking('Batch execution: ' + successCount + '/' + combinations.length + ' successful');

    // Deduplicate
    var uniqueResults = deduplicateByKey(allResults, dedupeKey);
    thinking('Deduplicated to ' + uniqueResults.length + ' unique results (from ' + allResults.length + ' total)');

    return {
      success: errors.length === 0,
      results: uniqueResults,
      api_calls_made: combinations.length,
      successful_calls: successCount,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Execute UNION in sequential mode (legacy behavior)
   * @private
   */
  function executeUnionSequential(config, combinations, paramNames, dedupeKey) {
    var allResults = [];
    var apiCallsMade = 0;

    for (var i = 0; i < combinations.length; i++) {
      var combo = combinations[i];

      // Build parameter object from combination
      var params = {};
      for (var j = 0; j < paramNames.length; j++) {
        params[paramNames[j]] = combo[j];
      }

      thinking('[' + (i + 1) + '/' + combinations.length + '] Fetching with params: ' + JSON.stringify(params));

      try {
        var results = config.apiCallFn(params);
        allResults = allResults.concat(results);
        apiCallsMade++;
      } catch (e) {
        // FAIL FAST per user decision
        return {
          success: false,
          error: 'API call failed on ' + (i + 1) + '/' + combinations.length + ': ' + e.message,
          partial_results: allResults.length + ' results retrieved before failure',
          api_calls_made: apiCallsMade
        };
      }
    }

    // Deduplicate
    var uniqueResults = deduplicateByKey(allResults, dedupeKey);
    thinking('Deduplicated to ' + uniqueResults.length + ' unique results (from ' + allResults.length + ' total)');

    return {
      success: true,
      results: uniqueResults,
      api_calls_made: apiCallsMade
    };
  }

  // Export functions
  module.exports = {
    matchesAny: matchesAny,
    cartesianProduct: cartesianProduct,
    deduplicateByKey: deduplicateByKey,
    applyFilters: applyFilters,
    applySorting: applySorting,
    applyTopN: applyTopN,
    estimateAndWarnApiCalls: estimateAndWarnApiCalls,
    executeUnion: executeUnion
  };
}

__defineModule__(_main);