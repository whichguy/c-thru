function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Centralized constants for Sheets Chat application
   * 
   * All magic numbers consolidated here for:
   * - Documentation of purpose
   * - Single source of truth
   * - Easy configuration override via ConfigManager
   * 
   * Usage:
   *   const { DEFAULTS, getConfig } = require('chat-core/ChatConstants');
   *   const value = getConfig('THINKING_BUDGET_TOKENS'); // Uses ConfigManager with default fallback
   *   const hardDefault = DEFAULTS.THINKING_BUDGET_TOKENS; // Direct access to default
   *
   * @module chat-core/ChatConstants
   */

  /**
   * Default values for all configurable constants
   * These are used when no ConfigManager override exists
   */
  const DEFAULTS = {
    // ============================================================================
    // THINKING CONFIGURATION
    // ============================================================================
    
    /**
     * Enable/disable extended thinking feature
     * @type {boolean}
     */
    THINKING_ENABLED: true,
    
    /**
     * Token budget for extended thinking (thinking block size limit)
     * Higher = more thorough reasoning, but slower + more expensive
     * @type {number}
     */
    THINKING_BUDGET_TOKENS: 2000,
    
    /**
     * Model used for extraction, summary, and redistillation operations
     * Opus provides higher quality but is slower/more expensive
     * @type {string}
     */
    THINKING_MODEL: 'claude-opus-4-20250514',
    
    // ============================================================================
    // TOKEN/CONTEXT CONFIGURATION
    // ============================================================================
    
    /**
     * Maximum tokens to request in Claude API response
     * @type {number}
     */
    MAX_RESPONSE_TOKENS: 4096,
    
    /**
     * Token threshold to trigger thread continuation (~70% of 200K context)
     * Accounts for 20-30% variance in heuristic token estimation
     * @type {number}
     */
    CONTEXT_TOKEN_THRESHOLD: 140000,
    
    /**
     * Token threshold to log warning (approaching limit)
     * Provides early notice before hitting continuation trigger
     * @type {number}
     */
    CONTEXT_WARNING_THRESHOLD: 100000,
    
    /**
     * Estimated tokens per image attachment
     * Conservative estimate - actual varies by image size/complexity
     * @type {number}
     */
    IMAGE_TOKEN_ESTIMATE: 1500,
    
    /**
     * Message count threshold (backup when token estimation unreliable)
     * If >N messages, force token re-estimation
     * @type {number}
     */
    MESSAGE_THRESHOLD: 80,
    
    // ============================================================================
    // MEMORY CONFIGURATION
    // ============================================================================
    
    /**
     * Maximum tokens for semantic memory block during continuation
     * @type {number}
     */
    MAX_MEMORY_BLOCK_TOKENS: 1500,
    
    /**
     * Maximum tokens for episodic summary during continuation
     * @type {number}
     */
    MAX_SUMMARY_TOKENS: 2000,
    
    /**
     * Number of recent user/assistant turn pairs to preserve verbatim
     * @type {number}
     */
    KEEP_RECENT_TURNS: 5,
    
    /**
     * Re-distill memory every N continuations to prevent bloat
     * @type {number}
     */
    REDISTILLATION_INTERVAL: 3,
    
    // ============================================================================
    // QUEUE CONFIGURATION
    // ============================================================================
    
    /**
     * Time-to-live for queued messages in seconds (6 hours)
     * After TTL, messages are considered stale and discarded
     * @type {number}
     */
    QUEUE_MESSAGE_TTL_SECONDS: 21600,
    
    /**
     * Lock timeout for queue operations in milliseconds (5 seconds)
     * Prevents deadlocks on concurrent queue access
     * @type {number}
     */
    QUEUE_LOCK_TIMEOUT_MS: 5000,
    
    // ============================================================================
    // UI CONFIGURATION
    // ============================================================================
    
    /**
     * Polling interval for thinking messages in milliseconds
     * Lower = more responsive UI, but more API calls
     * @type {number}
     */
    UI_POLLING_INTERVAL_MS: 300,
    
    /**
     * Auto-collapse thinking bubble when response arrives
     * @type {boolean}
     */
    UI_THINKING_AUTO_COLLAPSE: true,
    
    /**
     * Default sidebar width in pixels
     * @type {number}
     */
    UI_SIDEBAR_WIDTH: 400,

    /**
     * Enable inline suggested actions from primary model response
     * When true, actions parsed from <suggested-actions> XML in response
     * When false, falls back to async Haiku call (FollowUpSuggestions.gs)
     * @type {boolean}
     */
    INLINE_ACTIONS_ENABLED: true,

    // ============================================================================
    // API CONFIGURATION
    // ============================================================================

    /**
     * Claude API base URL prefix (without path)
     * Override for enterprise deployments with custom endpoints
     * @type {string}
     */
    CLAUDE_API_BASE_URL: 'https://api.anthropic.com',
  };

  /**
   * ConfigManager namespace for Sheets Chat configuration
   * @type {string}
   */
  const CONFIG_NAMESPACE = 'CLAUDE_CHAT';

  /**
   * Cached ConfigManager instance
   * @type {ConfigManager|null}
   * @private
   */
  let _configManager = null;

  /**
   * Get ConfigManager instance (cached)
   * @returns {ConfigManager}
   * @private
   */
  function _getConfigManager() {
    if (!_configManager) {
      const ConfigManager = require('gas-properties/ConfigManager');
      _configManager = new ConfigManager(CONFIG_NAMESPACE);
    }
    return _configManager;
  }

  /**
   * Get a configuration value with ConfigManager override support
   * 
   * Priority:
   * 1. ConfigManager value (if set by user/admin)
   * 2. DEFAULTS value (hardcoded fallback)
   * 
   * @param {string} key - Configuration key (must exist in DEFAULTS)
   * @returns {*} Configuration value
   * @throws {Error} If key doesn't exist in DEFAULTS
   * 
   * @example
   * const budget = getConfig('THINKING_BUDGET_TOKENS'); // 2000 (or user override)
   */
  function getConfig(key) {
    if (!(key in DEFAULTS)) {
      throw new Error(`Unknown config key: ${key}. Must be defined in DEFAULTS.`);
    }
    
    const defaultValue = DEFAULTS[key];
    
    try {
      const cm = _getConfigManager();
      const storedValue = cm.get(key, null);
      
      if (storedValue === null) {
        return defaultValue;
      }
      
      // Type coercion based on default type
      if (typeof defaultValue === 'number') {
        const parsed = parseFloat(storedValue);
        return isNaN(parsed) ? defaultValue : parsed;
      }
      if (typeof defaultValue === 'boolean') {
        return storedValue === 'true' || storedValue === true;
      }
      
      return storedValue;
    } catch (error) {
      // ConfigManager may fail in certain contexts (e.g., no active spreadsheet)
      // Fall back to default silently
      return defaultValue;
    }
  }

  /**
   * Set a configuration override
   * 
   * @param {string} key - Configuration key (must exist in DEFAULTS)
   * @param {*} value - Value to set
   * @param {string} scope - ConfigManager scope (default: 'script')
   * 
   * @example
   * setConfig('THINKING_BUDGET_TOKENS', 4000, 'script');
   */
  function setConfig(key, value, scope = 'script') {
    if (!(key in DEFAULTS)) {
      throw new Error(`Unknown config key: ${key}. Must be defined in DEFAULTS.`);
    }
    
    const cm = _getConfigManager();
    cm.set(key, String(value), scope);
  }

  /**
   * Clear ConfigManager cache (call after setConfig to ensure fresh reads)
   */
  function clearConfigCache() {
    _configManager = null;
  }

  /**
   * Get all current configuration values (defaults merged with overrides)
   * Useful for debugging/inspection
   * 
   * @returns {Object} All configuration key-value pairs
   */
  function getAllConfig() {
    const result = {};
    for (const key of Object.keys(DEFAULTS)) {
      result[key] = getConfig(key);
    }
    return result;
  }

  // ============================================================================
  // EXPORTS
  // ============================================================================

  module.exports = {
    // Default values (direct access)
    DEFAULTS,
    
    // ConfigManager namespace
    CONFIG_NAMESPACE,
    
    // Configuration accessors
    getConfig,
    setConfig,
    clearConfigCache,
    getAllConfig
  };
}

__defineModule__(_main);