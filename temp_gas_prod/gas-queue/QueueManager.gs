function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * QueueManager - Generic FIFO queue facility with channel support
   * Modern ES6+ implementation leveraging GAS V8 runtime
   * 
   * Features:
   * - Multiple independent channels (queues)
   * - FIFO ordering guaranteed
   * - Peek (non-destructive) and Pickup (destructive) operations
   * - Bulk operations (pickup multiple messages)
   * - Channel flush
   * - Pluggable backing stores (Cache, Properties, Drive)
   * - Thread-safe with LockService
   * - ES6+: Symbols, destructuring, template literals, generators
   */

  const CacheStoreAdapter = require('gas-queue/CacheStoreAdapter');
  const PropertiesStoreAdapter = require('gas-queue/PropertiesStoreAdapter');
  const DriveStoreAdapter = require('gas-queue/DriveStoreAdapter');

  // Private symbols for truly private methods
  const _store = Symbol('store');
  const _withLock = Symbol('withLock');
  const _getKey = Symbol('getKey');
  const _readQueue = Symbol('readQueue');
  const _writeQueue = Symbol('writeQueue');
  const _generateId = Symbol('generateId');

  class QueueManager {
    /**
     * Create queue manager
     * @param {Object} options - Configuration
     * @param {string} options.store - 'cache' | 'properties' | 'drive' (default: 'cache')
     * @param {string} options.namespace - Queue namespace (default: 'QUEUE')
     * @param {string} options.scope - 'user' | 'document' | 'script' (default: 'user')
     * @param {number} options.ttl - Time-to-live in seconds (cache only, default: 21600)
     * @param {string} options.drivePath - Custom Drive path (drive only, default: '.gas-queue')
     * @param {boolean} options.useLock - Use LockService (default: true)
     * @param {boolean} options.debug - Enable debug logging (default: false)
     */
    constructor({
      store = 'cache',
      namespace = 'QUEUE',
      scope = 'user',
      ttl = 21600,
      drivePath = '.gas-queue',
      useLock = true,
      debug = false
    } = {}) {
      // Store config with object shorthand
      this.config = {store, namespace, scope, ttl, drivePath, useLock, debug};
      
      // Lazy-initialized store (null until first use)
      this[_store] = null;
      
      if (debug) {
        Logger.log(`[QueueManager] Created: namespace=${namespace}, store=${store}, scope=${scope}`);
      }
    }

    /**
     * Lazy-loaded store adapter
     * Uses singleton pattern for Cache/Properties, new instance for Drive
     */
    get store() {
      if (!this[_store]) {
        const {store, scope, drivePath, namespace} = this.config;
        
        switch (store) {
          case 'cache':
            this[_store] = CacheStoreAdapter.getInstance(scope);
            break;
          case 'properties':
            this[_store] = PropertiesStoreAdapter.getInstance(scope);
            break;
          case 'drive':
            this[_store] = new DriveStoreAdapter({basePath: drivePath, namespace});
            break;
          default:
            throw new Error(`Unknown store type: ${store}`);
        }
      }
      
      return this[_store];
    }

    /**
     * Post message to channel (enqueue)
     */
    post(channel, data, metadata = {}) {
      const {debug} = this.config;
      
      return this[_withLock](() => {
        const key = this[_getKey](channel);
        const queue = this[_readQueue](key);
        const queueSizeBefore = queue.length;
        
        // Create message with object shorthand
        const message = {
          id: this[_generateId](),
          data,
          metadata,
          timestamp: Date.now(),
          channel
        };
        
        // Warn on large messages
        const messageJson = JSON.stringify(message);
        if (messageJson.length > 50000) {  // 50KB warning
          Logger.log(`[QueueManager] WARNING: Large message (${messageJson.length} bytes) posted to channel "${channel}"`);
        }
        
        queue.push(message);
        this[_writeQueue](key, queue);
        
        if (debug) {
          Logger.log(`[QueueManager] POST: channel="${channel}", msgId=${message.id}, dataLength=${JSON.stringify(data).length}, queueSize=${queueSizeBefore}->${queue.length}, metadata=${JSON.stringify(metadata)}`);
        }
        
        return true;
      });
    }

    /**
     * Pickup messages from channel (dequeue, destructive)
     *
     * @param {string} channel - Channel name
     * @param {number} count - Maximum messages to pickup (default: 1)
     * @param {number} waitMs - Optional wait time to allow message accumulation (default: 0)
     * @param {boolean} deleteIfEmpty - Delete channel after pickup if no messages remain (default: false)
     * @returns {Array} Array of messages
     *
     * Wait time allows messages to accumulate before pickup:
     * - waitMs = 0: Immediate pickup (default)
     * - waitMs = 300: Wait 300ms to allow batching (useful for polling)
     *
     * Delete behavior:
     * - deleteIfEmpty = false: Keep empty channel (default)
     * - deleteIfEmpty = true: Delete channel after pickup if empty (cleanup)
     */
    pickup(channel, count = 1, waitMs = 0, deleteIfEmpty = false) {
      const {debug} = this.config;
      
      // Optional wait for message accumulation
      if (waitMs > 0) {
        Utilities.sleep(waitMs);
      }

      return this[_withLock](() => {
        const key = this[_getKey](channel);
        const queue = this[_readQueue](key);
        const queueSizeBefore = queue.length;

        // Splice removes and returns elements (in-place)
        const picked = queue.splice(0, count);

        // Write back remaining or delete if empty
        const deleted = queue.length === 0;
        if (queue.length > 0) {
          this[_writeQueue](key, queue);
        } else {
          // Delete channel when empty (always delete empty channels to avoid cache pollution)
          this.store.delete(key);
        }
        
        if (debug) {
          Logger.log(`[QueueManager] PICKUP: channel="${channel}", requested=${count}, picked=${picked.length}, queueSize=${queueSizeBefore}->${queue.length}, deleted=${deleted}, msgIds=[${picked.map(m => m.id).join(', ')}]`);
        }

        return picked;
      });
    }

    /**
     * Peek at messages without removing (non-destructive)
     * No lock needed for read-only
     */
    peek(channel, count = 1) {
      const key = this[_getKey](channel);
      return this[_readQueue](key).slice(0, count);
    }

    /**
     * Flush entire channel (clear all messages)
     */
    flush(channel) {
      const {debug} = this.config;
      
      return this[_withLock](() => {
        const key = this[_getKey](channel);
        const size = this[_readQueue](key).length;
        
        this.store.delete(key);
        
        if (debug) {
          Logger.log(`[QueueManager] FLUSH: channel="${channel}", removed=${size} messages`);
        }
        
        return size;
      });
    }

    /**
     * Get channel size (message count)
     * No lock needed for read-only
     */
    size(channel) {
      const key = this[_getKey](channel);
      return this[_readQueue](key).length;
    }

    /**
     * List all channels in namespace
     */
    channels() {
      const {namespace, debug} = this.config;
      const prefix = `${namespace}:`;
      
      const channelList = this.store.keys(prefix)
        .map(key => key.slice(prefix.length));
      
      if (debug) {
        Logger.log(`[QueueManager] CHANNELS: found ${channelList.length} channels: [${channelList.join(', ')}]`);
      }
      
      return channelList;
    }

    /**
     * Get global or per-channel statistics
     * Uses optional chaining (?.) and nullish coalescing (??)
     * 
     * @param {string} channel - Optional channel name for per-channel stats
     * @returns {Object} Statistics object
     */
    stats(channel = null) {
      if (channel) {
        // Per-channel statistics
        const key = this[_getKey](channel);
        const queue = this[_readQueue](key);
        
        return {
          channel,
          size: queue.length,
          oldestTimestamp: queue[0]?.timestamp ?? null,
          newestTimestamp: queue[queue.length - 1]?.timestamp ?? null,
          totalBytes: JSON.stringify(queue).length
        };
      } else {
        // Global statistics across all channels
        const channelList = this.channels();
        let totalMessages = 0;
        
        channelList.forEach(ch => {
          totalMessages += this.size(ch);
        });
        
        return {
          channels: channelList.length,
          totalMessages,
          store: this.config.store,
          namespace: this.config.namespace,
          scope: this.config.scope
        };
      }
    }

    /**
     * Generator for memory-efficient iteration
     * Processes large queues in batches
     */
    *iterate(channel, batchSize = 10) {
      while (true) {
        const batch = this.peek(channel, batchSize);
        
        if (batch.length === 0) {
          break;
        }
        
        yield batch;
        
        // Pickup batch to advance
        this.pickup(channel, batch.length);
      }
    }

    // Private: Execute operation with lock
    [_withLock](operation) {
      const {useLock} = this.config;
      
      if (!useLock) {
        return operation();
      }
      
      const lock = LockService.getUserLock();
      
      if (!lock.tryLock(5000)) {
        throw new Error('Lock timeout after 5 seconds');
      }
      
      try {
        return operation();
      } finally {
        lock.releaseLock();
      }
    }

    // Private: Generate storage key with template literal
    [_getKey](channel) {
      const {namespace} = this.config;
      
      // Validate channel name (alphanumeric, underscore, hyphen only)
      if (!/^[a-zA-Z0-9_-]+$/.test(channel)) {
        throw new Error(`Invalid channel name: "${channel}". Use only alphanumeric characters, underscore, and hyphen.`);
      }
      
      return `${namespace}:${channel}`;
    }

    // Private: Read queue from store
    [_readQueue](key) {
      const json = this.store.read(key);
      return json ? JSON.parse(json) : [];
    }

    // Private: Write queue to store
    [_writeQueue](key, queue) {
      const {ttl} = this.config;
      this.store.write(key, JSON.stringify(queue), ttl);
    }

    // Private: Generate unique message ID
    [_generateId]() {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  module.exports = QueueManager;
}

__defineModule__(_main, false, { explicitName: 'gas-queue/QueueManager' });