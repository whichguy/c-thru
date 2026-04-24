function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Test Mock Utilities for USAW Tools
   * 
   * Provides mock responses and utilities for testing USAW dynamic tools
   * without making actual API calls.
   */

  /**
   * Creates a mock UrlFetchApp response
   * @param {number} statusCode - HTTP status code
   * @param {string|Object} content - Response content (will be JSON stringified if object)
   * @param {Object} headers - Optional response headers
   * @returns {Object} Mock HTTPResponse object
   */
  function createMockResponse(statusCode, content, headers) {
    var contentText = typeof content === 'object' ? JSON.stringify(content) : content;
    return {
      getResponseCode: function() { return statusCode; },
      getContentText: function() { return contentText; },
      getHeaders: function() { return headers || {}; },
      getBlob: function() { 
        return {
          getDataAsString: function() { return contentText; }
        };
      }
    };
  }

  /**
   * Creates synthetic filter response for usaw_filter_options
   * @returns {Object} Mock filter data
   */
  function createSyntheticFilterResponse() {
    return {
      filters: [
        {
          name: 'weight_class',
          items: [
            { id: '55', text: '55kg' },
            { id: '61', text: '61kg' },
            { id: '67', text: '67kg' },
            { id: '73', text: '73kg' },
            { id: '81', text: '81kg' },
            { id: '89', text: '89kg' },
            { id: '96', text: '96kg' },
            { id: '102', text: '102kg' },
            { id: '109', text: '109kg' },
            { id: '109+', text: '109+kg' }
          ]
        },
        {
          name: 'age_group',
          items: [
            { id: 'youth', text: 'Youth' },
            { id: 'junior', text: 'Junior' },
            { id: 'senior', text: 'Senior' },
            { id: 'master', text: 'Master' }
          ]
        },
        {
          name: 'gender',
          items: [
            { id: 'M', text: 'Male' },
            { id: 'F', text: 'Female' }
          ]
        }
      ]
    };
  }

  /**
   * Creates synthetic WSO records response
   * @param {string} wsoName - WSO organization name
   * @returns {Object} Mock WSO records
   */
  function createSyntheticWsoRecords(wsoName) {
    return {
      wso: wsoName || 'Pacific Weightlifting',
      records: [
        {
          weight_class: '73kg',
          snatch: 145,
          clean_jerk: 180,
          total: 325,
          athlete: 'John Smith',
          date: '2024-03-15'
        },
        {
          weight_class: '81kg',
          snatch: 155,
          clean_jerk: 195,
          total: 350,
          athlete: 'Mike Johnson',
          date: '2024-02-20'
        }
      ],
      updated: new Date().toISOString()
    };
  }

  /**
   * Creates synthetic IWF events response
   * @param {number} year - Year for events
   * @returns {Array} Mock IWF events
   */
  function createSyntheticIwfEvents(year) {
    var baseYear = year || new Date().getFullYear();
    return [
      {
        id: '1001',
        name: 'IWF World Championships',
        location: 'Riyadh, Saudi Arabia',
        country: 'KSA',
        start_date: baseYear + '-09-15',
        end_date: baseYear + '-09-24',
        type: 'World Championship'
      },
      {
        id: '1002',
        name: 'IWF Grand Prix I',
        location: 'Doha, Qatar',
        country: 'QAT',
        start_date: baseYear + '-03-01',
        end_date: baseYear + '-03-05',
        type: 'Grand Prix'
      },
      {
        id: '1003',
        name: 'IWF World Cup',
        location: 'Phuket, Thailand',
        country: 'THA',
        start_date: baseYear + '-04-10',
        end_date: baseYear + '-04-15',
        type: 'World Cup'
      }
    ];
  }

  /**
   * Creates synthetic event results response
   * @param {string} eventId - Event ID
   * @returns {Object} Mock event results
   */
  function createSyntheticEventResults(eventId) {
    return {
      event_id: eventId || '12345',
      event_name: '2024 National Championships',
      date: '2024-06-15',
      location: 'Columbus, OH',
      results: [
        {
          place: 1,
          athlete: 'John Smith',
          club: 'Fortified Strength',
          weight_class: '73kg',
          body_weight: 72.5,
          snatch: [130, 135, 140],
          snatch_best: 140,
          clean_jerk: [165, 172, 178],
          clean_jerk_best: 178,
          total: 318
        },
        {
          place: 2,
          athlete: 'Mike Johnson',
          club: 'California Strength',
          weight_class: '73kg',
          body_weight: 72.8,
          snatch: [128, 133, 138],
          snatch_best: 138,
          clean_jerk: [160, 168, 173],
          clean_jerk_best: 173,
          total: 311
        }
      ]
    };
  }

  /**
   * Creates synthetic USAW rankings response
   * @param {Object} filters - Filter criteria
   * @returns {Object} Mock rankings data with pagination
   */
  function createSyntheticRankings(filters) {
    filters = filters || {};
    return {
      data: [
        {
          rank: 1,
          name: 'John Smith',
          club: 'Fortified Strength',
          state: 'CA',
          weight_class: filters.weight_class || '73kg',
          total: 325,
          snatch: 145,
          clean_jerk: 180
        },
        {
          rank: 2,
          name: 'Mike Johnson',
          club: 'California Strength',
          state: 'CA',
          weight_class: filters.weight_class || '73kg',
          total: 318,
          snatch: 140,
          clean_jerk: 178
        }
      ],
      total: 50,
      page: filters.page || 1,
      per_page: 25
    };
  }

  /**
   * Mock UrlFetchApp wrapper for testing
   * Allows registering mock responses for specific URL patterns
   */
  var MockUrlFetch = {
    _responses: {},
    _calls: [],
    
    /**
     * Register a mock response for a URL pattern
     * @param {string|RegExp} urlPattern - URL or pattern to match
     * @param {Object} response - Mock response object
     */
    addResponse: function(urlPattern, response) {
      this._responses[urlPattern.toString()] = response;
    },
    
    /**
     * Clear all mock responses
     */
    clear: function() {
      this._responses = {};
      this._calls = [];
    },
    
    /**
     * Get call history
     * @returns {Array} Array of {url, options} objects
     */
    getCalls: function() {
      return this._calls;
    },
    
    /**
     * Mock fetch implementation
     * @param {string} url - URL to fetch
     * @param {Object} options - Fetch options
     * @returns {Object} Mock response
     */
    fetch: function(url, options) {
      this._calls.push({ url: url, options: options });
      
      // Check for matching pattern
      for (var pattern in this._responses) {
        var regex = new RegExp(pattern);
        if (regex.test(url)) {
          return this._responses[pattern];
        }
      }
      
      // Default 404 response
      return createMockResponse(404, { error: 'Not found' });
    }
  };

  /**
   * Asserts that a value is truthy
   * @param {*} value - Value to check
   * @param {string} message - Error message
   */
  function assertTruthy(value, message) {
    if (!value) {
      throw new Error(message || 'Expected truthy value, got: ' + value);
    }
  }

  /**
   * Asserts that two values are equal
   * @param {*} actual - Actual value
   * @param {*} expected - Expected value
   * @param {string} message - Error message
   */
  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error((message || 'Assertion failed') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  }

  /**
   * Asserts that a value is an array
   * @param {*} value - Value to check
   * @param {string} message - Error message
   */
  function assertArray(value, message) {
    if (!Array.isArray(value)) {
      throw new Error((message || 'Expected array') + ', got ' + typeof value);
    }
  }

  /**
   * Asserts that an object has a property
   * @param {Object} obj - Object to check
   * @param {string} prop - Property name
   * @param {string} message - Error message
   */
  function assertHasProperty(obj, prop, message) {
    if (!obj || typeof obj !== 'object' || !(prop in obj)) {
      throw new Error((message || 'Expected property ' + prop) + ' not found');
    }
  }

  module.exports = {
    createMockResponse: createMockResponse,
    createSyntheticFilterResponse: createSyntheticFilterResponse,
    createSyntheticWsoRecords: createSyntheticWsoRecords,
    createSyntheticIwfEvents: createSyntheticIwfEvents,
    createSyntheticEventResults: createSyntheticEventResults,
    createSyntheticRankings: createSyntheticRankings,
    MockUrlFetch: MockUrlFetch,
    assertTruthy: assertTruthy,
    assertEqual: assertEqual,
    assertArray: assertArray,
    assertHasProperty: assertHasProperty
  };
}

__defineModule__(_main);