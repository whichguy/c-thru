// then-later/core/WatchdogService.gs - Periodic cleanup and system health monitoring

function _main(module, exports, log) {

  class WatchdogService {
    constructor(config = {}) {
      if (!config.driveStorage) {
        throw new Error('WatchdogService requires driveStorage instance');
      }
      if (!config.stateManager) {
        throw new Error('WatchdogService requires jobStateManager instance');
      }
      if (!config.triggerManager) {
        throw new Error('WatchdogService requires triggerManager instance');
      }

      this.driveStorage = config.driveStorage;
      this.stateManager = config.stateManager;
      this.triggerManager = config.triggerManager;
      this.maxTriggers = config.maxTriggers || 15;
    }

    runHealthCheck() {
      log('Starting watchdog health check');

      const stats = {
        staleLocksRemoved: 0,
        registryCleanups: 0,
        resultsRemoved: 0,
        deadLettersRemoved: 0,
        triggersCreated: 0,
        propertiesCleaned: 0
      };

      try {
        stats.staleLocksRemoved = this.cleanStaleLocks();
        stats.registryCleanups = this.processLockCleanupRegistry();

        const resultStats = this.cleanOldResults();
        stats.resultsRemoved = resultStats.results;
        stats.deadLettersRemoved = resultStats.deadLetters;

        stats.triggersCreated = this.ensureTriggersForPendingJobs();
        stats.propertiesCleaned = this.cleanupScriptProperties();

        log('Watchdog health check completed | ' + JSON.stringify(stats));

        return stats;
      } catch (e) {
        log('[E] Watchdog health check failed: ' + e.message);
        throw e;
      }
    }

    cleanStaleLocks() {
      log('Cleaning stale locks');

      const lockCutoff = new Date(Date.now() - 15 * 60 * 1000);
      let cleanupCount = 0;
      let errorCount = 0;

      const locksFolder = this.driveStorage.getFolder('locks');
      const files = locksFolder.getFiles();

      while (files.hasNext()) {
        const file = files.next();

        if (file.getDateCreated() < lockCutoff) {
          try {
            file.setTrashed(true);
            cleanupCount++;
            log('Cleaned stale lock | ' + JSON.stringify({ filename: file.getName() }));
          } catch (e) {
            errorCount++;
            log('[W] Failed to clean stale lock | ' + JSON.stringify({ filename: file.getName(), error: e.message }));
          }
        }
      }

      log('Stale locks cleaned | ' + JSON.stringify({ cleanupCount, errorCount }));
      return cleanupCount;
    }

    processLockCleanupRegistry() {
      log('Processing lock cleanup registry');

      let registryCleanupCount = 0;

      this._withScriptPropertiesLock((props) => {
        try {
          const registryStr = props.getProperty('LockCleanupRegistry');

          if (registryStr) {
            let registry = JSON.parse(registryStr);
            let remainingLocks = {};

            Object.entries(registry).forEach(([lockName, timestamp]) => {
              try {
                const locksFolder = this.driveStorage.getFolder('locks');
                const lockFiles = locksFolder.getFilesByName(lockName);

                if (lockFiles.hasNext()) {
                  const lockFile = lockFiles.next();
                  lockFile.setTrashed(true);
                  registryCleanupCount++;
                  log('Cleaned registry lock | ' + JSON.stringify({ lockName }));
                } else {
                  registryCleanupCount++;
                }
              } catch (e) {
                remainingLocks[lockName] = timestamp;
                log('[W] Failed to clean registry lock | ' + JSON.stringify({ lockName, error: e.message }));
              }
            });

            if (Object.keys(remainingLocks).length > 0) {
              props.setProperty('LockCleanupRegistry', JSON.stringify(remainingLocks));
            } else {
              props.deleteProperty('LockCleanupRegistry');
            }
          }
        } catch (e) {
          log('[E] Lock registry cleanup failed: ' + e.message);
        }
      });

      log('Lock cleanup registry processed | ' + JSON.stringify({ registryCleanupCount }));
      return registryCleanupCount;
    }

    cleanOldResults() {
      log('Cleaning old results');

      const resultCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const stats = { results: 0, deadLetters: 0 };

      ['results', 'deadLetters'].forEach(type => {
        const folder = this.driveStorage.getFolder(type);
        const files = folder.getFiles();

        while (files.hasNext()) {
          const file = files.next();

          if (file.getDateCreated() < resultCutoff) {
            try {
              file.setTrashed(true);
              stats[type]++;
              log('Cleaned old result file | ' + JSON.stringify({ type, filename: file.getName() }));
            } catch (e) {
              log('[W] Failed to clean old result file | ' + JSON.stringify({ type, filename: file.getName(), error: e.message }));
            }
          }
        }
      });

      log('Old results cleaned | ' + JSON.stringify(stats));
      return stats;
    }

    ensureTriggersForPendingJobs() {
      log('Checking for orphaned jobs');

      const hasPendingJobs = this.stateManager.hasPendingJobs();
      const currentTriggers = this.triggerManager.getActiveTriggerCount();

      log('Trigger check | ' + JSON.stringify({ hasPendingJobs, currentTriggers, maxTriggers: this.maxTriggers }));

      let triggersCreated = 0;

      if (hasPendingJobs) {
        if (currentTriggers === 0) {
          log('[W] Found pending jobs with no triggers - restarting processing');
          this.triggerManager.createProcessingTrigger();
          triggersCreated = 1;
        } else if (currentTriggers < this.maxTriggers) {
          const needed = Math.min(3, this.maxTriggers - currentTriggers);
          log('Adding triggers to reach capacity | ' + JSON.stringify({ needed }));

          for (let i = 0; i < needed; i++) {
            this.triggerManager.createProcessingTrigger();
            triggersCreated++;
          }
        }
      }

      log('Trigger check completed | ' + JSON.stringify({ triggersCreated }));
      return triggersCreated;
    }

    cleanupScriptProperties() {
      log('Cleaning Script Properties');

      let cleanupCount = 0;
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      this._withScriptPropertiesLock((props) => {
        const allProps = props.getProperties();

        // Single-pass cleanup: cancellation requests + stale SCHEDULER_JOB_* entries
        Object.keys(allProps).forEach(key => {
          if (key.startsWith('cancel_')) {
            const triggerId = key.substring(7);
            const triggerExists = ScriptApp.getProjectTriggers().some(t =>
              t.getUniqueId() === triggerId && t.getHandlerFunction() === 'processQueue'
            );

            if (!triggerExists) {
              props.deleteProperty(key);
              cleanupCount++;
              log('Cleaned stale cancellation request | ' + JSON.stringify({ key }));
            }
          } else if (key.startsWith('SCHEDULER_JOB_')) {
            try {
              const meta = JSON.parse(allProps[key]);
              if (meta && meta.scheduledAt) {
                const scheduledMs = Date.parse(meta.scheduledAt);
                if (!isNaN(scheduledMs) && scheduledMs < sevenDaysAgo) {
                  props.deleteProperty(key);
                  const jobId = key.substring('SCHEDULER_JOB_'.length);
                  props.deleteProperty('SCHEDULER_NOTIFY_' + jobId);
                  cleanupCount++;
                  log('Cleaned stale scheduler job entry | ' + JSON.stringify({ key }));
                }
              }
            } catch (e) {
              // Corrupt entry - delete silently
              props.deleteProperty(key);
              cleanupCount++;
              log('Cleaned corrupt scheduler job entry | ' + JSON.stringify({ key }));
            }
          }
        });
      });

      log('Script Properties cleaned | ' + JSON.stringify({ cleanupCount }));
      return cleanupCount;
    }

    _withScriptPropertiesLock(callback, timeout = 30000, retries = 3) {
      let currentRetry = 0;

      while (currentRetry <= retries) {
        const lock = LockService.getScriptLock();
        let lockAcquired = false;

        try {
          lockAcquired = lock.tryLock(timeout);

          if (!lockAcquired) {
            throw new Error('Failed to acquire script lock');
          }

          const props = PropertiesService.getScriptProperties();
          const result = callback(props);

          return result;
        } catch (e) {
          log('[W] Script Properties lock failed | ' + JSON.stringify({ attempt: currentRetry + 1, maxAttempts: retries + 1, error: e.message }));

          if (currentRetry < retries) {
            Utilities.sleep(1000 * Math.pow(2, currentRetry));
            currentRetry++;
          } else {
            throw new Error(`Script Properties lock failed after ${retries} retries: ${e.message}`);
          }
        } finally {
          if (lockAcquired) {
            try {
              lock.releaseLock();
            } catch (e) {
              // Lock already released
            }
          }
        }
      }
    }

    getQuotaStats() {
      const usage = DriveApp.getStorageUsed();
      const limit = DriveApp.getStorageLimit();
      const usagePercent = (usage / limit) * 100;

      const stats = {
        storageUsed: usage,
        storageLimit: limit,
        storagePercent: usagePercent,
        triggerCount: this.triggerManager.getActiveTriggerCount(),
        triggerLimit: this.maxTriggers
      };

      log('Quota stats | ' + JSON.stringify(stats));
      return stats;
    }

    isQuotaCritical() {
      const stats = this.getQuotaStats();
      return stats.storagePercent > 90;
    }
  }

  module.exports = { WatchdogService };
}

__defineModule__(_main);
