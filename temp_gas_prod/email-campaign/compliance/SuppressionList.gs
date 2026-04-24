// email-campaign/compliance/SuppressionList.gs
// Wraps the _Suppression Sheet tab with an in-memory Set cache for O(1) lookups.
// Provides the compliance layer that prevents sending to opted-out addresses.

function _main(module, exports, log) {

  const { getSuppressionSet, addSuppression: _addSuppression } = require('email-campaign/storage/CampaignStorage');

  // In-memory Set cache — populated on first call, lives for the duration of one trigger execution.
  let _cache = null;

  /**
   * Returns true if the email address is in the suppression list.
   * Loads the entire _Suppression tab into memory on first call per execution.
   */
  function isSuppressed(email) {
    if (!_cache) {
      _cache = getSuppressionSet();
      log('SuppressionList: loaded ' + _cache.size + ' suppressed emails into cache');
    }
    return _cache.has(String(email).toLowerCase().trim());
  }

  /**
   * Adds an email to the suppression list (Sheet + in-memory cache).
   * Idempotent — silently returns false if already suppressed.
   *
   * @param {string} email
   * @param {string} reason - 'unsubscribe' | 'hard_bounce' | 'complaint' | 'manual'
   * @param {string} source - e.g. 'campaign:abc123'
   * @param {string} method - 'one-click' | 'link' | 'bounce' | 'manual'
   */
  function addSuppression(email, reason, source, method) {
    const normalized = String(email).toLowerCase().trim();
    const added = _addSuppression(normalized, reason, source, method);
    if (added && _cache) {
      _cache.add(normalized); // Keep in-memory cache consistent
    }
    return added;
  }

  /**
   * Returns the current suppression count (from cache if loaded, else from Sheet).
   */
  function getCount() {
    if (_cache) return _cache.size;
    return getSuppressionSet().size;
  }

  module.exports = { isSuppressed, addSuppression, getCount };

} // end _main

__defineModule__(_main);
