function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * CacheStoreAdapter - CacheService storage backend
   * Fast, temporary storage with 6-hour TTL limit
   * 
   * Features:
   * - Very fast (5-20ms operations)
   * - 6-hour maximum TTL
   * - 100KB per item, 10MB total limit
   * - Module-level singleton pattern
   * - Best for: thinking messages, temporary logs, high-throughput queues
   */

  const QueueStoreAdapter = require('gas-queue/QueueStoreAdapter');

  // Module-level singleton cache
  const adapterInstances = new Map();

  // Private methods using Symbols
  const _registerChannel = Symbol('registerChannel');
  const _unregisterChannel = Symbol('unregisterChannel');

  class CacheStoreAdapter extends QueueStoreAdapter {
    /**
     * Get singleton instance for scope
     * @param {string} scope - 'user' | 'document' | 'script'
     * @returns {CacheStoreAdapter} Singleton instance
     */
    static getInstance(scope = 'user') {
      const key = `cache:${scope}`;
      
      if (!adapterInstances.has(key)) {
        adapterInstances.set(key, new CacheStoreAdapter(scope));
      }
      
      return adapterInstances.get(key);
    }

    constructor(scope = 'user') {
      super();
      
      // Enforce singleton pattern
      const key = `cache:${scope}`;
      if (adapterInstances.has(key)) {
        return adapterInstances.get(key);
      }
      
      // Initialize CacheService based on scope
      this.cache = scope === 'user'
        ? CacheService.getUserCache()
        : scope === 'document'
        ? CacheService.getDocumentCache()
        : CacheService.getScriptCache();
      
      this.scope = scope;
      
      // Cache registry for tracking channels
      this.registryKey = '__queue_registry__';
      
      // Register singleton
      adapterInstances.set(key, this);
    }

    read(key) {
      try {
        return this.cache.get(key);
      } catch (error) {
        Logger.log(`[CacheStore] Read error for ${key}: ${error.message}`);
        return null;
      }
    }

    write(key, value, ttl = 21600) {
      try {
        // CacheService max TTL is 21600 seconds (6 hours)
        const actualTtl = Math.min(ttl, 21600);
        this.cache.put(key, value, actualTtl);
        
        // Register channel in registry
        this[_registerChannel](key);
      } catch (error) {
        Logger.log(`[CacheStore] Write error for ${key}: ${error.message}`);
        throw error;
      }
    }

    delete(key) {
      try {
        this.cache.remove(key);
        
        // Unregister channel from registry
        this[_unregisterChannel](key);
      } catch (error) {
        Logger.log(`[CacheStore] Delete error for ${key}: ${error.message}`);
        throw error;
      }
    }

    keys(pattern) {
      try {
        // CacheService doesn't support key listing
        // Use registry to track channels
        const registryJson = this.cache.get(this.registryKey);
        const registry = registryJson ? JSON.parse(registryJson) : [];
        
        // Filter by pattern (prefix match)
        return registry.filter(key => key.startsWith(pattern));
      } catch (error) {
        Logger.log(`[CacheStore] Keys error: ${error.message}`);
        return [];
      }
    }

    getType() {
      return 'cache';
    }

    supportsTTL() {
      return true;
    }

    // Private helper to register channel in registry
    [_registerChannel](key) {
      try {
        const registryJson = this.cache.get(this.registryKey);
        const registry = registryJson ? JSON.parse(registryJson) : [];
        
        if (!registry.includes(key)) {
          registry.push(key);
          // Store registry with max TTL
          this.cache.put(this.registryKey, JSON.stringify(registry), 21600);
        }
      } catch (error) {
        // Non-critical, just log
        Logger.log(`[CacheStore] Registry register error: ${error.message}`);
      }
    }

    // Private helper to unregister channel from registry
    [_unregisterChannel](key) {
      try {
        const registryJson = this.cache.get(this.registryKey);
        if (!registryJson) return;
        
        const registry = JSON.parse(registryJson);
        const filtered = registry.filter(k => k !== key);
        
        if (filtered.length > 0) {
          this.cache.put(this.registryKey, JSON.stringify(filtered), 21600);
        } else {
          this.cache.remove(this.registryKey);
        }
      } catch (error) {
        // Non-critical, just log
        Logger.log(`[CacheStore] Registry unregister error: ${error.message}`);
      }
    }
  }

  module.exports = CacheStoreAdapter;
}

__defineModule__(_main, false, { explicitName: 'gas-queue/CacheStoreAdapter' });