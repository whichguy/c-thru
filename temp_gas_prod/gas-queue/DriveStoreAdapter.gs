function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * DriveStoreAdapter - Google Drive storage backend
   * Unlimited persistent storage with file-based approach
   * 
   * Features:
   * - Unlimited storage (15GB free)
   * - Persistent forever
   * - Slower (200-500ms operations)
   * - Human-readable JSON files
   * - Well-known path: /.gas-queue/{namespace}/
   * - Best for: large datasets, archives, manual inspection
   */

  const QueueStoreAdapter = require('gas-queue/QueueStoreAdapter');

  // Private symbols for methods
  const _getOrCreateFolder = Symbol('getOrCreateFolder');
  const _getFile = Symbol('getFile');
  const _createOrUpdateFile = Symbol('createOrUpdateFile');

  class DriveStoreAdapter extends QueueStoreAdapter {
    constructor({basePath = '.gas-queue', namespace = 'DEFAULT'} = {}) {
      super();
      
      this.basePath = basePath;
      this.namespace = namespace;
      
      // Use Map for folder caching (faster than object)
      this.folderCache = new Map();
      
      // Initialize folder structure
      this.namespaceFolder = this[_getOrCreateFolder](
        this[_getOrCreateFolder](DriveApp.getRootFolder(), basePath),
        namespace
      );
    }

    read(key) {
      try {
        const file = this[_getFile](key);
        
        if (!file) {
          return null;
        }
        
        return file.getBlob().getDataAsString();
      } catch (error) {
        Logger.log(`[DriveStore] Read error for ${key}: ${error.message}`);
        return null;
      }
    }

    write(key, value, ttl) {
      try {
        // Drive doesn't support TTL - persist forever
        // ttl parameter ignored
        this[_createOrUpdateFile](key, value);
      } catch (error) {
        Logger.log(`[DriveStore] Write error for ${key}: ${error.message}`);
        throw error;
      }
    }

    delete(key) {
      try {
        const file = this[_getFile](key);
        
        if (file) {
          file.setTrashed(true);
        }
      } catch (error) {
        Logger.log(`[DriveStore] Delete error for ${key}: ${error.message}`);
        throw error;
      }
    }

    keys(pattern) {
      try {
        const channels = [];
        const files = this.namespaceFolder.getFiles();
        
        while (files.hasNext()) {
          const file = files.next();
          const name = file.getName();
          
          // Strip .json extension
          if (name.endsWith('.json') && name !== '__registry__.json') {
            const channelKey = name.slice(0, -5);
            
            // Filter by pattern (prefix match)
            if (channelKey.startsWith(pattern)) {
              channels.push(channelKey);
            }
          }
        }
        
        return channels;
      } catch (error) {
        Logger.log(`[DriveStore] Keys error: ${error.message}`);
        return [];
      }
    }

    getType() {
      return 'drive';
    }

    supportsTTL() {
      return false;
    }

    /**
     * Get Drive folder path for debugging
     * @returns {string} Path like /.gas-queue/THINKING/
     */
    getPath() {
      return `/${this.basePath}/${this.namespace}/`;
    }

    /**
     * Get Drive folder URL for manual inspection
     * @returns {string} URL to folder in Drive
     */
    getFolderUrl() {
      return this.namespaceFolder.getUrl();
    }

    // Private: Get or create folder by name
    [_getOrCreateFolder](parent, name) {
      const cacheKey = `${parent.getId()}:${name}`;
      
      // Check cache
      if (this.folderCache.has(cacheKey)) {
        return this.folderCache.get(cacheKey);
      }
      
      // Search for existing folder
      const folders = parent.getFoldersByName(name);
      let folder;
      
      if (folders.hasNext()) {
        folder = folders.next();
      } else {
        // Create new folder
        folder = parent.createFolder(name);
      }
      
      // Cache folder reference
      this.folderCache.set(cacheKey, folder);
      return folder;
    }

    // Private: Get file by channel name
    [_getFile](channel) {
      const fileName = `${channel}.json`;
      const files = this.namespaceFolder.getFilesByName(fileName);
      
      if (files.hasNext()) {
        return files.next();
      }
      
      return null;
    }

    // Private: Create or update file
    [_createOrUpdateFile](channel, content) {
      const fileName = `${channel}.json`;
      const existingFile = this[_getFile](channel);
      
      if (existingFile) {
        // Update existing file
        existingFile.setContent(content);
        return existingFile;
      } else {
        // Create new file
        return this.namespaceFolder.createFile(fileName, content, MimeType.PLAIN_TEXT);
      }
    }
  }

  module.exports = DriveStoreAdapter;
}

__defineModule__(_main, false, { explicitName: 'gas-queue/DriveStoreAdapter' });