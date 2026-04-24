function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Event classification for NTP qualifying events
   *
   * Per 2026 NTP Policy Section 4:
   * - Gold/Silver: International events only
   * - Bronze/Developmental: International OR National events
   *
   * @module tools/helpers/UsawEventClassifier
   */

  // ============================================================================
  // INTERNATIONAL EVENT PATTERNS
  // ============================================================================

  const INTERNATIONAL_PATTERNS = [
    /olympic\s*games?/i,
    /pan\s*-?\s*american\s*(games?|championships?)/i,
    /world\s*championships?/i,
    /iwf/i,
    /fisu/i,
    /continental\s*championships?/i,
    /junior\s*pan\s*-?\s*american\s*games?/i,
    /youth\s*pan\s*-?\s*american/i,
    /olympic\s*qualification/i,
    /world\s*university/i,
    /grand\s*prix/i
  ];

  // ============================================================================
  // NATIONAL EVENT PATTERNS
  // ============================================================================

  const NATIONAL_PATTERNS = [
    /national\s*championships?/i,
    /usa\s*nationals?/i,
    /usaw\s*nationals?/i,
    /virus\s*weightlifting/i,
    /virus\s*series/i,
    /youth\s*nationals?/i,
    /junior\s*nationals?/i,
    /u\s*-?\s*2[35]\s*nationals?/i,
    /senior\s*nationals?/i,
    /masters?\s*nationals?/i,
    /university\s*nationals?/i,
    /american\s*open/i,
    /usa\s*weightlifting\s*(?:open|championships?)/i,
    // Additional national-level patterns (USAW sanctions these as National/International level)
    /arnold\s*(classic|sports\s*festival|weightlifting)?/i,  // Arnold series
    /olympic\s*trials/i,
    /team\s*usa\s*qualifier/i,
    /collegiate\s*nationals?/i,
    /university\s*championships?/i,
    /u\.?s\.?\s*open/i,  // U.S. Open
    /state\s*championships?/i,  // State championships (treat as national for broader reach)
    /regional\s*championships?/i,  // Regional championships
    /sanctioned\s*national/i,  // Explicitly sanctioned national
    /usa\s*weightlifting\s*.{0,30}(?:qualifier|selection)/i  // USAW qualifiers/selections
  ];

  // ============================================================================
  // CLASSIFICATION FUNCTIONS
  // ============================================================================

  function classifyEvent(eventName) {
    if (!eventName || typeof eventName !== 'string') {
      return 'local';
    }

    const name = eventName.trim();

    for (const pattern of INTERNATIONAL_PATTERNS) {
      if (pattern.test(name)) {
        return 'international';
      }
    }

    for (const pattern of NATIONAL_PATTERNS) {
      if (pattern.test(name)) {
        return 'national';
      }
    }

    return 'local';
  }

  function isQualifyingEvent(eventName, level) {
    const eventType = classifyEvent(eventName);

    if (eventType === 'local') {
      return false;
    }

    const levelLower = (level || '').toLowerCase();
    if (levelLower === 'gold' || levelLower === 'silver') {
      return eventType === 'international';
    }

    if (levelLower === 'bronze' || levelLower === 'developmental') {
      return eventType === 'international' || eventType === 'national';
    }

    return false;
  }

  function getPatterns() {
    return {
      international: INTERNATIONAL_PATTERNS.map(p => p.toString()),
      national: NATIONAL_PATTERNS.map(p => p.toString())
    };
  }

  // ============================================================================
  // EXPORTS
  // ============================================================================

  module.exports = {
    classifyEvent,
    isQualifyingEvent,
    getPatterns,
    INTERNATIONAL_PATTERNS,
    NATIONAL_PATTERNS
  };
}

__defineModule__(_main);
