// then-later/storage/DriveStorage.gs - Drive operations with aggressive caching

function _main(module, exports, log) {

  class DriveStorage {
    constructor(config = {}) {
      this.rootFolderName = config.rootFolderName || 'ScheduledScripts';

      this.memoryCache = new Map();
      this.cache = CacheService.getScriptCache();

      this.folderStructure = {
        root: this.rootFolderName,
        jobs: `${this.rootFolderName}/Jobs`,
        locks: `${this.rootFolderName}/Locks`,
        results: `${this.rootFolderName}/Results`,
        deadLetters: `${this.rootFolderName}/DeadLetters`
      };

      this.initialized = false;
    }

    initialize() {
      log('Initializing folder structure');

      try {
        this.setupFolders();
        this.initialized = true;
        log('Folder structure initialized');
      } catch (e) {
        this.initialized = false;
        log('[E] Folder structure initialization failed: ' + e.message);
        throw new Error(`Failed to initialize folder structure: ${e.message}`);
      }
    }

    setupFolders() {
      let rootFolder;
      const rootFolders = DriveApp.getFoldersByName(this.rootFolderName);

      if (!rootFolders.hasNext()) {
        rootFolder = DriveApp.createFolder(this.rootFolderName);
        log('Created root folder | ' + JSON.stringify({ name: this.rootFolderName }));
      } else {
        rootFolder = rootFolders.next();
        log('Found existing root folder | ' + JSON.stringify({ name: this.rootFolderName }));
      }

      this.cacheFolderId('root', rootFolder.getId());
      this.memoryCache.set('root', rootFolder);

      const subfolders = {
        jobs: 'Jobs',
        locks: 'Locks',
        results: 'Results',
        deadLetters: 'DeadLetters'
      };

      Object.entries(subfolders).forEach(([type, name]) => {
        const folders = rootFolder.getFoldersByName(name);
        let folder;

        if (!folders.hasNext()) {
          folder = rootFolder.createFolder(name);
          log('Created subfolder | ' + JSON.stringify({ name }));
        } else {
          folder = folders.next();
          log('Found existing subfolder | ' + JSON.stringify({ name }));
        }

        this.cacheFolderId(type, folder.getId());
        this.memoryCache.set(type, folder);
      });
    }

    getFolder(type) {
      if (this.memoryCache.has(type)) {
        log('Folder cache hit (memory) | ' + JSON.stringify({ type }));
        return this.memoryCache.get(type);
      }

      const cachedId = this.getCachedFolderId(type);
      if (cachedId) {
        try {
          const folder = DriveApp.getFolderById(cachedId);
          this.memoryCache.set(type, folder);
          log('Folder cache hit (CacheService) | ' + JSON.stringify({ type }));
          return folder;
        } catch (e) {
          log('Cached folder ID invalid, re-fetching | ' + JSON.stringify({ type }));
          this.cache.remove(`folder:${type}`);
        }
      }

      log('Folder cache miss, fetching from Drive | ' + JSON.stringify({ type }));
      const folderPath = this.folderStructure[type];

      if (!folderPath) {
        throw new Error(`Unknown folder type: ${type}`);
      }

      let folder;
      if (type === 'root') {
        const folders = DriveApp.getFoldersByName(this.rootFolderName);
        if (!folders.hasNext()) {
          throw new Error(`Root folder not found: ${this.rootFolderName}`);
        }
        folder = folders.next();
        if (folders.hasNext()) {
          log('[W] Multiple root folders found with same name; using first | ' + JSON.stringify({ name: this.rootFolderName }));
        }
      } else {
        const rootFolder = this.getFolder('root');
        const subfolderName = folderPath.split('/')[1];
        const folders = rootFolder.getFoldersByName(subfolderName);

        if (!folders.hasNext()) {
          throw new Error(`Subfolder not found: ${subfolderName}`);
        }
        folder = folders.next();
        if (folders.hasNext()) {
          log('[W] Multiple subfolders found with same name; using first | ' + JSON.stringify({ name: subfolderName }));
        }
      }

      this.cacheFolderId(type, folder.getId());
      this.memoryCache.set(type, folder);

      return folder;
    }

    cacheFolderId(type, folderId) {
      const TTL = 21600; // 6 hours in seconds
      this.cache.put(`folder:${type}`, folderId, TTL);
      log('Cached folder ID | ' + JSON.stringify({ type, folderId }));
    }

    getCachedFolderId(type) {
      return this.cache.get(`folder:${type}`);
    }

    clearCache() {
      this.memoryCache.clear();
      ['root', 'jobs', 'locks', 'results', 'deadLetters'].forEach(type => {
        this.cache.remove(`folder:${type}`);
      });
      log('Cleared all folder caches');
    }

    getCacheStats() {
      return {
        memorySize: this.memoryCache.size,
        memoryCached: Array.from(this.memoryCache.keys()),
        cacheServiceCached: ['root', 'jobs', 'locks', 'results', 'deadLetters']
          .filter(type => this.getCachedFolderId(type) !== null)
      };
    }
  }

  module.exports = { DriveStorage };
}

__defineModule__(_main);
