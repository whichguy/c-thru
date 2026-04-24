function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * QueueStoreAdapter - Abstract base class for queue storage backends
   * Defines interface that all storage adapters must implement
   * 
   * Supports three implementations:
   * - CacheStoreAdapter (CacheService)
   * - PropertiesStoreAdapter (PropertiesService)
   * - DriveStoreAdapter (Google Drive)
   */

  class QueueStoreAdapter {
    /**
     * Read data from store
     * @param {string} key - Storage key
     * @returns {string|null} JSON string or null if not found
     */
    read(key) {
      throw new Error('Method read() must be implemented by subclass');
    }

    /**
     * Write data to store
     * @param {string} key - Storage key
     * @param {string} value - JSON string to store
     * @param {number} ttl - Time-to-live in seconds (optional, store-dependent)
     */
    write(key, value, ttl) {
      throw new Error('Method write() must be implemented by subclass');
    }

    /**
     * Delete key from store
     * @param {string} key - Storage key
     */
    delete(key) {
      throw new Error('Method delete() must be implemented by subclass');
    }

    /**
     * List all keys matching pattern
     * @param {string} pattern - Key prefix pattern
     * @returns {Array<string>} Array of matching keys
     */
    keys(pattern) {
      throw new Error('Method keys() must be implemented by subclass');
    }

    /**
     * Get store type name
     * @returns {string} Store type ('cache', 'properties', 'drive')
     */
    getType() {
      return 'unknown';
    }

    /**
     * Check if store supports TTL
     * @returns {boolean} True if TTL is supported
     */
    supportsTTL() {
      return false;
    }
  }

  module.exports = QueueStoreAdapter;
}

__defineModule__(_main, false, { explicitName: 'gas-queue/QueueStoreAdapter' });