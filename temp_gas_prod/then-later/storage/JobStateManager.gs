// then-later/storage/JobStateManager.gs - Job state transitions with multi-layer locking

function _main(module, exports, log) {

  const JOB_STATES = {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    DELAYED: 'DELAYED'
  };

  const FileUtils = {
    createJobFilename(state, jobId, description = '') {
      const safeDescription = description ?
        description.substring(0, 20).replace(/[^a-zA-Z0-9_-]/g, '_') :
        '';

      return safeDescription ?
        `${state}-${jobId}-${safeDescription}.json` :
        `${state}-${jobId}.json`;
    },

    parseJobFilename(filename) {
      const regex = /^([A-Z]+)-([^-]+)(?:-(.+?))?\.json$/;
      const match = filename.match(regex);

      if (!match) return null;

      return {
        state: match[1],
        jobId: match[2],
        description: match[3] || '',
        fullFilename: filename
      };
    },

    generateJobId() {
      return Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
    }
  };

  class JobStateManager {
    constructor(config = {}) {
      if (!config.driveStorage) {
        throw new Error('JobStateManager requires driveStorage instance');
      }

      this.driveStorage = config.driveStorage;
      this.jobContentCache = new Map();
    }

    transitionJobState(file, folderType, newState, modifyFn = null) {
      try {
        const jobData = this.getJobContent(file);

        if (modifyFn && typeof modifyFn === 'function') {
          modifyFn(jobData);
        }

        jobData.state = newState;
        jobData.lastUpdated = new Date().toISOString();

        if (!jobData.metadata) {
          jobData.metadata = {};
        }

        const newName = FileUtils.createJobFilename(
          newState,
          jobData.jobId,
          jobData.metadata.description || ''
        );

        const destFolder = this.driveStorage.getFolder(folderType);
        const newFile = destFolder.createFile(newName, JSON.stringify(jobData));

        file.setTrashed(true);

        this.jobContentCache.delete(file.getId());

        log('Transitioned job state | ' + JSON.stringify({ oldFile: file.getName(), newFile: newName, newState, folderType }));

        return newFile;
      } catch (err) {
        log('[E] Failed to transition job state: ' + err.message + ' | ' + JSON.stringify({ file: file.getName(), newState, folderType }));
        throw err;
      }
    }

    acquireLock(jobFile, triggerId) {
      const MAX_RETRIES = 2;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const jobData = this.getJobContent(jobFile);

          jobData.lock = {
            triggerId: triggerId,
            acquiredAt: new Date().toISOString()
          };

          const lockFile = this.transitionJobState(
            jobFile,
            'locks',
            JOB_STATES.RUNNING,
            (data) => {
              data.lock = jobData.lock;
              return data;
            }
          );

          log('Lock acquired | ' + JSON.stringify({ file: lockFile.getName(), triggerId }));

          return lockFile;
        } catch (err) {
          log('[W] Lock acquisition attempt failed | ' + JSON.stringify({ attempt, maxRetries: MAX_RETRIES, error: err.message }));

          if (attempt < MAX_RETRIES) {
            Utilities.sleep(1000 * attempt);
          }
        }
      }

      return null;
    }

    releaseLock(lockFile, destinationState, resultData = null) {
      const folderMap = {
        [JOB_STATES.SUCCESS]: 'results',
        [JOB_STATES.FAILED]: 'deadLetters',
        [JOB_STATES.PENDING]: 'jobs'
      };

      const folderType = folderMap[destinationState] || 'jobs';

      try {
        return this.transitionJobState(
          lockFile,
          folderType,
          destinationState,
          (jobData) => {
            jobData.completedAt = new Date().toISOString();

            if (destinationState === JOB_STATES.SUCCESS) {
              jobData.result = resultData || { success: true };
            } else if (destinationState === JOB_STATES.FAILED) {
              jobData.error = resultData || { message: "Job failed" };
            }

            delete jobData.lock;

            return jobData;
          }
        );
      } catch (error) {
        log('[E] Failed to release lock: ' + error.message + ' | ' + JSON.stringify({ file: lockFile.getName(), destinationState }));

        try {
          lockFile.setTrashed(true);
        } catch (e) {
          // Last resort failed
        }

        return null;
      }
    }

    getJobContent(file) {
      const fileId = file.getId();

      if (this.jobContentCache.has(fileId)) {
        log('Job content cache hit | ' + JSON.stringify({ fileId }));
        return JSON.parse(JSON.stringify(this.jobContentCache.get(fileId)));
      }

      const content = JSON.parse(file.getBlob().getDataAsString());
      this.jobContentCache.set(fileId, content);

      log('Job content cache miss | ' + JSON.stringify({ fileId }));
      return content;
    }

    getNextJobFile(triggerId) {
      const scriptLock = LockService.getScriptLock();
      let lockAcquired = false;

      try {
        scriptLock.waitLock(30000);
        lockAcquired = true;

        const jobsFolder = this.driveStorage.getFolder('jobs');
        const files = jobsFolder.getFiles();

        while (files.hasNext()) {
          const file = files.next();

          if (!this.isLocked(file)) {
            const lockFile = this.acquireLock(file, triggerId);

            if (lockFile) {
              log('Acquired lock on job | ' + JSON.stringify({ file: file.getName(), triggerId }));
              return lockFile;
            }
          }
        }

        return null;
      } catch (e) {
        log('[E] Script lock error: ' + e.message);
        return null;
      } finally {
        if (lockAcquired) {
          scriptLock.releaseLock();
        }
      }
    }

    isLocked(file) {
      const parsed = FileUtils.parseJobFilename(file.getName());
      if (!parsed) return false;
      const locksFolder = this.driveStorage.getFolder('locks');
      const lockFiles = locksFolder.getFiles();
      while (lockFiles.hasNext()) {
        const lockFile = lockFiles.next();
        const lockParsed = FileUtils.parseJobFilename(lockFile.getName());
        if (lockParsed && lockParsed.jobId === parsed.jobId) return true;
      }
      return false;
    }

    hasPendingJobs() {
      const jobsFolder = this.driveStorage.getFolder('jobs');
      return jobsFolder.getFiles().hasNext();
    }

    clearCache() {
      this.jobContentCache.clear();
      log('Cleared job content cache');
    }

    getCacheStats() {
      return {
        jobContentCacheSize: this.jobContentCache.size,
        cachedFileIds: Array.from(this.jobContentCache.keys())
      };
    }
  }

  module.exports = {
    JobStateManager,
    JOB_STATES,
    FileUtils
  };
}

__defineModule__(_main);
