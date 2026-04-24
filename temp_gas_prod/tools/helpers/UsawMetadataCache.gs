function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Metadata cache for USAW API filter options
   * Caches weight class, WSO, club, level mappings from API
   * Reduces API calls and improves performance
   */

  // Module-level cache (persists during execution context)
  var _rankingsMetaCache = null;
  var _eventsMetaCache = null;

  /**
   * Get rankings API metadata (weight_class, level, club, wso)
   * @return {Object|null} Metadata maps { weightClassMap, levelMap, clubMap, wsoMap } or null if fetch fails
   */
  function getRankingsFilterMeta() {
    if (_rankingsMetaCache) {
      return _rankingsMetaCache;
    }

    var url = 'https://admin-usaw-rankings.sport80.com/api/categories/all/rankings/table';
    var options = {
      headers: { 'x-api-token': getUsawApiToken() },
      muteHttpExceptions: true
    };

    try {
      var resp = UrlFetchApp.fetch(url, options);
      if (resp.getResponseCode() !== 200) {
        thinking('Warning: Failed to fetch rankings metadata (HTTP ' + resp.getResponseCode() + ')');
        return null;
      }

      var meta = JSON.parse(resp.getContentText());
      _rankingsMetaCache = {
        weightClassMap: {},
        levelMap: {},
        clubMap: {},
        wsoMap: {}
      };

      // Parse filters array
      (meta.filters || []).forEach(function(filter) {
        if (!filter.items) return;

        var mapKey = filter.name + 'Map';
        if (!_rankingsMetaCache[mapKey]) return;

        filter.items.forEach(function(item) {
          // ID → Name
          _rankingsMetaCache[mapKey][item.value] = item.text;
          // Name (lowercase) → ID
          _rankingsMetaCache[mapKey][item.text.toLowerCase()] = item.value;
        });
      });

      thinking('Rankings metadata cached: ' +
               Object.keys(_rankingsMetaCache.wsoMap).length / 2 + ' WSOs, ' +
               Object.keys(_rankingsMetaCache.levelMap).length / 2 + ' levels');

      return _rankingsMetaCache;

    } catch (e) {
      thinking('Error fetching rankings metadata: ' + e.message);
      return null;
    }
  }

  /**
   * Get events locator API metadata (region/state, event_type)
   * @return {Object|null} Metadata maps { stateMap, eventTypeMap } or null if fetch fails
   */
  function getEventsFilterMeta() {
    if (_eventsMetaCache) {
      return _eventsMetaCache;
    }

    var url = 'https://usaweightlifting.sport80.com/api/public/events/locator';

    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) {
        thinking('Warning: Failed to fetch events metadata (HTTP ' + resp.getResponseCode() + ')');
        return null;
      }

      var meta = JSON.parse(resp.getContentText());
      _eventsMetaCache = {
        stateMap: {},
        eventTypeMap: {}
      };

      (meta.filter || []).forEach(function(filter) {
        if (!filter.items) return;

        if (filter.name === 'region') {
          filter.items.forEach(function(item) {
            _eventsMetaCache.stateMap[item.value] = item.text;
            _eventsMetaCache.stateMap[item.text.toLowerCase()] = item.value;
          });
        }

        if (filter.name === 'event_type') {
          filter.items.forEach(function(item) {
            _eventsMetaCache.eventTypeMap[item.value] = item.text;
            _eventsMetaCache.eventTypeMap[item.text.toLowerCase()] = item.value;
          });
        }
      });

      thinking('Events metadata cached: ' +
               Object.keys(_eventsMetaCache.stateMap).length / 2 + ' states, ' +
               Object.keys(_eventsMetaCache.eventTypeMap).length / 2 + ' event types');

      return _eventsMetaCache;

    } catch (e) {
      thinking('Error fetching events metadata: ' + e.message);
      return null;
    }
  }

  /**
   * Helper to get USAW API token from script properties
   * @return {string} API token or empty string
   */
  function getUsawApiToken() {
    var token = PropertiesService.getScriptProperties().getProperty('USAW_API_TOKEN');
    return token || '';
  }

  /**
   * Clear metadata cache (for testing or manual refresh)
   */
  function clearUsawMetadataCache() {
    _rankingsMetaCache = null;
    _eventsMetaCache = null;
    thinking('USAW metadata cache cleared');
  }

  /**
   * Resolve weight class ID from name or number
   * @param {string|number} wcInput - Weight class (e.g., "81", "Men's 81kg", 81)
   * @return {number|null} Weight class ID or null if not found
   */
  function resolveWeightClassId(wcInput) {
    var Normalizers = require('tools/helpers/UsawNormalizers');
    var wcId = Normalizers.parseWeightClass(wcInput);
    
    if (wcId === null) {
      // Try to lookup by name in cache
      var meta = getRankingsFilterMeta();
      if (meta && meta.weightClassMap) {
        var lowerInput = String(wcInput).toLowerCase();
        wcId = meta.weightClassMap[lowerInput];
      }
    }
    
    return wcId;
  }

  /**
   * Resolve WSO ID from name
   * @param {string} wsoName - WSO name (e.g., "California North Central")
   * @return {string|number|null} WSO ID or null if not found
   */
  function resolveWsoId(wsoName) {
    if (!wsoName) return null;
    
    var meta = getRankingsFilterMeta();
    if (!meta || !meta.wsoMap) return null;
    
    var lowerName = String(wsoName).toLowerCase();
    return meta.wsoMap[lowerName] || null;
  }

  /**
   * Resolve level ID from name
   * @param {string} levelName - Level name (e.g., "National", "Regional")
   * @return {string|number|null} Level ID or null if not found
   */
  function resolveLevelId(levelName) {
    if (!levelName) return null;
    
    var meta = getRankingsFilterMeta();
    if (!meta || !meta.levelMap) return null;
    
    var Normalizers = require('tools/helpers/UsawNormalizers');
    var normalized = Normalizers.normalizeLevel(levelName);
    var lowerName = normalized.toLowerCase();
    
    return meta.levelMap[lowerName] || null;
  }

  /**
   * Resolve event type ID from name
   * @param {string} eventTypeName - Event type name (e.g., "Meets", "Courses")
   * @return {string|number|null} Event type ID or null if not found
   */
  function resolveEventTypeId(eventTypeName) {
    if (!eventTypeName) return null;
    
    var meta = getEventsFilterMeta();
    if (!meta || !meta.eventTypeMap) return null;
    
    var Normalizers = require('tools/helpers/UsawNormalizers');
    var normalized = Normalizers.normalizeEventType(eventTypeName);
    var lowerName = normalized.toLowerCase();
    
    return meta.eventTypeMap[lowerName] || null;
  }

  // Export functions
  module.exports = {
    getRankingsFilterMeta: getRankingsFilterMeta,
    getEventsFilterMeta: getEventsFilterMeta,
    clearUsawMetadataCache: clearUsawMetadataCache,
    getUsawApiToken: getUsawApiToken,
    resolveWeightClassId: resolveWeightClassId,
    resolveWsoId: resolveWsoId,
    resolveLevelId: resolveLevelId,
    resolveEventTypeId: resolveEventTypeId
  };
}

__defineModule__(_main);