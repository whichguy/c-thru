function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Normalization helpers for USAW tool parameters
   * Handles flexible inputs (abbreviations, variants) for consistent API queries
   */

  // State abbreviation to full name mapping
  var STATE_ABBR_MAP = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
    'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
    'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii',
    'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
    'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine',
    'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
    'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska',
    'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico',
    'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
    'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island',
    'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
    'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
    'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'
  };

  /**
   * Normalize state names from abbreviations or full names
   * @param {Array<string>} states - Array of state names or abbreviations
   * @return {Array<string>} Normalized full state names
   */
  function normalizeStates(states) {
    if (!states || !Array.isArray(states) || states.length === 0) {
      return [];
    }
    return states.map(function(s) {
      // Handle null/undefined items
      if (s == null) return '';
      var upper = String(s).trim().toUpperCase();
      return STATE_ABBR_MAP[upper] || s.trim();
    }).filter(function(s) { return s !== ''; });  // Remove empty strings
  }

  /**
   * Normalize gender input to M or F
   * @param {string} gender - Gender input ('M', 'F', 'Male', 'Female', etc.)
   * @return {string|null} 'M', 'F', or null if invalid
   */
  function normalizeGender(gender) {
    if (!gender) return null;
    var g = String(gender).trim().toUpperCase();
    if (g === 'MALE' || g === 'M') return 'M';
    if (g === 'FEMALE' || g === 'F') return 'F';
    return null;
  }

  /**
   * Parse weight class input (accepts ID, name, or number)
   * Note: Assumes weight class 0 is invalid. If 0 is a valid weight class, update this logic.
   * @param {string|number} wcInput - Weight class (e.g., "81", "Men's 81kg", 81)
   * @return {number|null} Weight class ID or null if invalid
   */
  function parseWeightClass(wcInput) {
    if (wcInput === null || wcInput === undefined) return null;
    
    var str = String(wcInput).trim();
    
    // If pure number, return as-is
    if (/^\d+$/.test(str)) {
      return parseInt(str, 10);
    }
    
    // Extract number from string like "Men's 81kg" or "81kg"
    var match = str.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  /**
   * Parse weight class array/string input
   * @param {string|number|Array<string|number>} input - Weight class(es)
   * @return {Array<number>} Array of weight class IDs
   */
  function parseWeightClasses(input) {
    if (!input) return [];

    // Validate input type
    if (typeof input !== 'string' && typeof input !== 'number' && !Array.isArray(input)) {
      throw new Error('parseWeightClasses expects string, number, or array, got ' + typeof input);
    }

    // If already array, parse each element
    if (Array.isArray(input)) {
      return input.map(parseWeightClass).filter(function(wc) { return wc !== null; });
    }

    // If string with commas, split and parse
    if (typeof input === 'string' && input.includes(',')) {
      return input.split(',').map(function(s) {
        return parseWeightClass(s.trim());
      }).filter(function(wc) { return wc !== null; });
    }

    // Single value
    var parsed = parseWeightClass(input);
    return parsed !== null ? [parsed] : [];
  }

  /**
   * Normalize division name (handle variants)
   * @param {string} division - Division name or abbreviation
   * @return {string} Normalized division name
   */
  function normalizeDivision(division) {
    if (!division) return '';
    
    var div = String(division).trim().toLowerCase();
    
    // Common abbreviations
    var divisionMap = {
      'jr': 'Junior',
      'sr': 'Senior',
      'yth': 'Youth',
      'masters': 'Masters',
      'youth': 'Youth',
      'junior': 'Junior',
      'senior': 'Senior'
    };
    
    return divisionMap[div] || division.trim();
  }

  /**
   * Normalize level name (handle variants)
   * @param {string} level - Level name or abbreviation
   * @return {string} Normalized level name
   */
  function normalizeLevel(level) {
    if (!level) return '';
    
    var lv = String(level).trim().toLowerCase();
    
    // Common abbreviations
    var levelMap = {
      'nat': 'National',
      'reg': 'Regional',
      'loc': 'Local',
      'intl': 'International',
      'national': 'National',
      'regional': 'Regional',
      'local': 'Local',
      'international': 'International'
    };
    
    return levelMap[lv] || level.trim();
  }

  /**
   * Normalize age category (handle variants)
   * @param {string} ageCategory - Age category name
   * @return {string} Normalized age category name
   */
  function normalizeAgeCategory(ageCategory) {
    if (!ageCategory) return '';
    
    var ac = String(ageCategory).trim().toLowerCase();
    
    // Common variants
    var categoryMap = {
      'youth': 'Youth',
      'junior': 'Junior',
      'senior': 'Senior',
      'masters': 'Masters',
      'm35': 'Masters 35+',
      'm40': 'Masters 40+',
      'm45': 'Masters 45+',
      'm50': 'Masters 50+',
      'm55': 'Masters 55+',
      'm60': 'Masters 60+',
      'm65': 'Masters 65+',
      'm70': 'Masters 70+'
    };
    
    return categoryMap[ac] || ageCategory.trim();
  }

  /**
   * Parse event type input (handle variants)
   * @param {string} eventType - Event type name or abbreviation
   * @return {string} Normalized event type name
   */
  function normalizeEventType(eventType) {
    if (!eventType) return '';
    
    var et = String(eventType).trim().toLowerCase();
    
    // Common variants
    var eventTypeMap = {
      'meet': 'Meets',
      'meets': 'Meets',
      'competition': 'Meets',
      'comp': 'Meets',
      'course': 'Courses',
      'courses': 'Courses',
      'clinic': 'Courses',
      'training': 'Courses'
    };
    
    return eventTypeMap[et] || eventType.trim();
  }

  // Export functions
  module.exports = {
    normalizeStates: normalizeStates,
    normalizeGender: normalizeGender,
    parseWeightClass: parseWeightClass,
    parseWeightClasses: parseWeightClasses,
    normalizeDivision: normalizeDivision,
    normalizeLevel: normalizeLevel,
    normalizeAgeCategory: normalizeAgeCategory,
    normalizeEventType: normalizeEventType
  };
}

__defineModule__(_main);