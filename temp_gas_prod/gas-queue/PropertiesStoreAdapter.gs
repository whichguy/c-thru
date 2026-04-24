function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * PropertiesStoreAdapter - PropertiesService storage backend
   * Persistent storage with 9KB per item limit
   * 
   * Features:
   * - Persistent (survives script execution)
   * - Slower (50-200ms operations)
   * - 9KB per item, 500KB total limit
   * - Module-level singleton pattern
   * - Best for: small config, audit logs, critical data
   */

  const QueueStoreAdapter = require('gas-queue/QueueStoreAdapter');

  // Module-level singleton cache
  const adapterInstances = new Map();

  class PropertiesStoreAdapter extends QueueStoreAdapter {
    /**
     * Get singleton instance for scope
     * @param {string} scope - 'user' | 'document' | 'script'
     * @returns {PropertiesStoreAdapter} Singleton instance
     */
    static getInstance(scope = 'user') {
      const key = `properties:${scope}`;
      
      if (!adapterInstances.has(key)) {
        adapterInstances.set(key, new PropertiesStoreAdapter(scope));
      }
      
      return adapterInstances.get(key);
    }

    constructor(scope = 'user') {
      super();
      
      // Enforce singleton pattern
      const key = `properties:${scope}`;
      if (adapterInstances.has(key)) {
        return adapterInstances.get(key);
      }
      
      // Initialize PropertiesService based on scope
      this.properties = scope === 'user'
        ? PropertiesService.getUserProperties()
        : scope === 'document'
        ? PropertiesService.getDocumentProperties()
        : PropertiesService.getScriptProperties();
      
      this.scope = scope;
      
      // Register singleton
      adapterInstances.set(key, this);
    }

    read(key) {
      try {
        return this.properties.getProperty(key);
      } catch (error) {
        Logger.log(`[PropertiesStore] Read error for ${key}: ${error.message}`);
        return null;
      }
    }

    write(key, value, ttl) {
      try {
        // PropertiesService doesn't support TTL - persist forever
        // ttl parameter ignored
        this.properties.setProperty(key, value);
      } catch (error) {
        Logger.log(`[PropertiesStore] Write error for ${key}: ${error.message}`);
        throw error;
      }
    }

    delete(key) {
      try {
        this.properties.deleteProperty(key);
      } catch (error) {
        Logger.log(`[PropertiesStore] Delete error for ${key}: ${error.message}`);
        throw error;
      }
    }

    keys(pattern) {
      try {
        // PropertiesService supports key listing
        const allKeys = this.properties.getKeys();
        
        // Filter by pattern (prefix match)
        return allKeys.filter(key => key.startsWith(pattern));
      } catch (error) {
        Logger.log(`[PropertiesStore] Keys error: ${error.message}`);
        return [];
      }
    }

    getType() {
      return 'properties';
    }

    supportsTTL() {
      return false;
    }
  }

  module.exports = PropertiesStoreAdapter;
}

__defineModule__(_main, false, { explicitName: 'gas-queue/PropertiesStoreAdapter' });