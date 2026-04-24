function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { TriggerManager } = require('then-later/core/TriggerManager');
  const { DriveStorage } = require('then-later/storage/DriveStorage');
  const { JobStateManager, JOB_STATES, FileUtils } = require('then-later/storage/JobStateManager');
  const { JobExecutor, FunctionPathError, JobExecutionError } = require('then-later/core/JobExecutor');
  const { JobRepository, NoResultsFoundError, JobValidationError } = require('then-later/storage/JobRepository');
  const { WatchdogService } = require('then-later/core/WatchdogService');

  class JobScheduler {
    constructor(config = {}) {
      this.maxTriggers = config.maxTriggers || 15;
      this.maxRuntime = config.maxRuntime || 450000; // 7.5 minutes

      this.driveStorage = new DriveStorage({ rootFolderName: config.rootFolderName });
      this.stateManager = new JobStateManager({
        driveStorage: this.driveStorage
      });
      this.triggerManager = new TriggerManager({
        maxTriggers: this.maxTriggers
      });
      this.jobExecutor = new JobExecutor();
      this.jobRepository = new JobRepository({
        driveStorage: this.driveStorage
      });
      this.watchdogService = new WatchdogService({
        driveStorage: this.driveStorage,
        stateManager: this.stateManager,
        triggerManager: this.triggerManager,
        maxTriggers: this.maxTriggers
      });

      this.currentContext = {
        triggerId: null,
        startTime: null
      };

      log('JobScheduler initialized');
    }

    create(functionPath, ...args) {
      log('Creating new job | ' + JSON.stringify({ functionPath }));
      this.jobExecutor.validateFunctionPath(functionPath);
      return new JobBuilder(this).thenAfter(functionPath, ...args);
    }

    processQueue(triggerId) {
      log('Starting queue processing | ' + JSON.stringify({ triggerId }));

      this.currentContext.triggerId = triggerId;
      this.currentContext.startTime = Date.now();

      try {
        if (this.isCancellationRequested(triggerId)) {
          log('Cancellation already requested | ' + JSON.stringify({ triggerId }));
          return;
        }

        this.triggerManager.deleteCurrentTrigger(triggerId);

        let processedCount = 0;
        let skippedAll = true;

        while (Date.now() - this.currentContext.startTime < this.maxRuntime) {
          const jobFiles = this.jobRepository.getJobBatch(5);

          if (jobFiles.length === 0) {
            log('No more jobs to process');
            break;
          }

          let batchProcessedAny = false;

          for (const jobFile of jobFiles) {
            const { shouldProcess, jobContent } = this.checkJobReadiness(jobFile);

            if (!shouldProcess) {
              if (jobContent) {
                this.handleDelayedJob(jobFile, jobContent);
              }
              continue;
            }

            batchProcessedAny = true;
            skippedAll = false;

            const lockFile = this.stateManager.acquireLock(jobFile, triggerId);
            if (!lockFile) {
              log('Failed to acquire lock | ' + JSON.stringify({ filename: jobFile.getName() }));
              continue;
            }

            this.registerActiveJob(triggerId, lockFile.getName());

            try {
              this.processJobFile(lockFile, triggerId);
              processedCount++;
            } catch (error) {
              log('[E] Job processing failed: ' + error.message + ' | ' + JSON.stringify({ filename: lockFile.getName() }));
            } finally {
              this.unregisterActiveJob(triggerId);
            }

            if (Date.now() - this.currentContext.startTime >= this.maxRuntime) {
              log('Approaching timeout, stopping processing');
              break;
            }
          }

          if (Date.now() - this.currentContext.startTime >= this.maxRuntime) {
            break;
          }

          // If the entire batch was delayed, avoid spinning — exit the while loop
          // and fall through to the skippedAll / hasPendingJobs checks below.
          if (!batchProcessedAny) {
            break;
          }
        }

        log('Queue processing completed | ' + JSON.stringify({ processedCount, duration: Date.now() - this.currentContext.startTime }));

        if (skippedAll && this.stateManager.hasPendingJobs()) {
          const earliestTime = this.jobRepository.findEarliestFutureJobTime();
          if (earliestTime) {
            log('Scheduling trigger for earliest future job | ' + JSON.stringify({ time: earliestTime }));
            this.triggerManager.createProcessingTrigger({ scheduleType: 'once', isoTime: earliestTime });
            return;
          }
        }

        if (this.stateManager.hasPendingJobs()) {
          log('Pending jobs remain, creating new trigger');
          this.triggerManager.createProcessingTrigger();
        }
      } catch (error) {
        log('[E] Queue processing failed: ' + error.message);
        throw error;
      } finally {
        this.clearCancellation(triggerId);
        this.currentContext.triggerId = null;
        this.currentContext.startTime = null;
      }
    }

    processJobFile(lockFile, triggerId) {
      log('Processing job file | ' + JSON.stringify({ filename: lockFile.getName() }));

      const startTime = new Date().toISOString();
      let job;
      let runningFile;

      try {
        job = this.stateManager.getJobContent(lockFile);
        this.jobRepository.validateJobStructure(job);

        if (job.metadata.weeklySchedule) {
          const { daysOfWeek } = job.metadata.weeklySchedule;
          const dayNum = new Date().getDay();

          if (!daysOfWeek.includes(dayNum)) {
            log('Skipping job - wrong day of week | ' + JSON.stringify({ dayNum, daysOfWeek }));
            this.handleRepeat(job);
            this.stateManager.releaseLock(lockFile, JOB_STATES.PENDING, {
              skipped: true,
              reason: `Day ${dayNum} not in scheduled days [${daysOfWeek}]`
            });
            return;
          }
        }

        // Record execution details in-place — avoids Drive create+trash for RUNNING→RUNNING
        job.executionDetails = {
          startTime: startTime,
          triggerId: triggerId,
          startStep: job.metadata.resumeIndex || 0
        };
        lockFile.setContent(JSON.stringify(job));
        this.stateManager.jobContentCache.delete(lockFile.getId());
        runningFile = lockFile;

        const results = [];
        let errorOccurred = false;
        const startStep = job.metadata.resumeIndex || 0;
        const context = {};
        let prevResult = null;

        for (let index = startStep; index < job.steps.length; index++) {
          job.metadata.resumeIndex = index;

          if (this.isCancellationRequested(triggerId)) {
            log('Cancellation requested, aborting job | ' + JSON.stringify({ triggerId }));
            break;
          }

          if (errorOccurred) break;

          try {
            const step = job.steps[index];
            this.updateActiveJobFunction(triggerId, step.functionPath);

            log('Executing step | ' + JSON.stringify({ step: index + 1, total: job.steps.length, functionPath: step.functionPath }));

            prevResult = this.jobExecutor.executeStep(step, prevResult, context);
            results.push(prevResult);

            if (job.metadata.storeIntermediate) {
              this.saveIntermediateResult(runningFile, step, prevResult);
            }
          } catch (error) {
            errorOccurred = true;
            const duration = Date.now() - new Date(startTime).getTime();
            this.handleJobError(runningFile, job, error, index, startTime, duration);
          }
        }

        if (!errorOccurred) {
          const duration = Date.now() - new Date(startTime).getTime();
          this.saveFinalResult(runningFile, results, job, startTime, duration);
          this.handleRepeat(job);
          log('Job completed successfully | ' + JSON.stringify({ filename: runningFile.getName() }));
        }
      } catch (error) {
        const duration = Date.now() - new Date(startTime).getTime();

        if (job) {
          this.handleJobError(runningFile || lockFile, job, error, -1, startTime, duration);
        } else {
          log('[E] Invalid job file: ' + error.message + ' | ' + JSON.stringify({ filename: lockFile.getName() }));
          this.handleInvalidJobError(lockFile, error, startTime, duration);
        }

        throw error;
      } finally {
        try {
          const fileToClean = runningFile || lockFile;
          if (fileToClean && !fileToClean.isTrashed()) {
            fileToClean.setTrashed(true);
          }
        } catch (e) {
          // File already trashed or inaccessible
        }
      }
    }

    checkJobReadiness(jobFile) {
      try {
        const jobContent = this.stateManager.getJobContent(jobFile);

        if (jobContent && jobContent.metadata && jobContent.metadata.startEarliestTime) {
          const earliest = new Date(jobContent.metadata.startEarliestTime).getTime();
          if (Date.now() < earliest) {
            return { shouldProcess: false, jobContent };
          }
        }

        return { shouldProcess: true, jobContent };
      } catch (error) {
        log('[W] Failed to check job readiness | ' + JSON.stringify({ filename: jobFile.getName(), error: error.message }));
        return { shouldProcess: false, jobContent: null };
      }
    }

    handleDelayedJob(jobFile, jobContent) {
      log('Job is delayed | ' + JSON.stringify({ filename: jobFile.getName(), startEarliestTime: jobContent.metadata.startEarliestTime }));
    }

    saveIntermediateResult(runningFile, step, result) {
      try {
        const jobData = this.stateManager.getJobContent(runningFile);
        if (!jobData.intermediateResults) {
          jobData.intermediateResults = [];
        }

        jobData.intermediateResults.push({
          step: step.functionPath,
          result: result,
          timestamp: new Date().toISOString()
        });

        runningFile.setContent(JSON.stringify(jobData));
      } catch (error) {
        log('[W] Failed to save intermediate result | ' + JSON.stringify({ error: error.message }));
      }
    }

    saveFinalResult(runningFile, results, job, startTime, duration) {
      log('Saving final result');

      this.stateManager.transitionJobState(
        runningFile,
        'results',
        JOB_STATES.SUCCESS,
        (data) => {
          data.results = results;
          data.metadata = {
            originalJob: job,
            startTime: startTime,
            endTime: new Date().toISOString(),
            duration: duration,
            triggerId: this.currentContext.triggerId
          };
        }
      );
    }

    handleJobError(jobFile, job, error, stepIndex, startTime, duration) {
      log('[E] Handling job error: ' + error.message + ' | ' + JSON.stringify({ stepIndex }));

      this.stateManager.transitionJobState(
        jobFile,
        'deadLetters',
        JOB_STATES.FAILED,
        (data) => {
          data.error = {
            message: error.message,
            stack: error.stack,
            stepIndex: stepIndex,
            stepPath: stepIndex >= 0 && job.steps[stepIndex] ? job.steps[stepIndex].functionPath : null
          };
          data.metadata = {
            originalJob: job,
            startTime: startTime,
            endTime: new Date().toISOString(),
            duration: duration,
            triggerId: this.currentContext.triggerId
          };
        }
      );
    }

    handleInvalidJobError(jobFile, error, startTime, duration) {
      log('[E] Handling invalid job error: ' + error.message);

      const errorData = {
        state: JOB_STATES.FAILED,
        error: {
          message: `Invalid job file: ${error.message}`,
          stack: error.stack
        },
        metadata: {
          originalFilename: jobFile.getName(),
          startTime: startTime,
          endTime: new Date().toISOString(),
          duration: duration,
          triggerId: this.currentContext.triggerId
        }
      };

      try {
        const deadLettersFolder = this.driveStorage.getFolder('deadLetters');
        const filename = FileUtils.createJobFilename(
          JOB_STATES.FAILED,
          FileUtils.generateJobId(),
          'Invalid'
        );
        deadLettersFolder.createFile(filename, JSON.stringify(errorData));
        jobFile.setTrashed(true);
      } catch (e) {
        log('[E] Failed to handle invalid job: ' + e.message);
      }
    }

    handleRepeat(job) {
      if (!job.metadata.repeat) return;

      const { mode, count, intervalMs } = job.metadata.repeat;
      const currentCount = job.metadata.repeatCount || 0;

      if (mode === 'count' && currentCount >= count) {
        log('Job repeat count reached | ' + JSON.stringify({ currentCount, maxCount: count }));
        return;
      }

      if (mode === 'infinite' || (mode === 'count' && currentCount < count)) {
        log('Scheduling job repeat | ' + JSON.stringify({ mode, currentCount }));

        const newJob = {
          ...job,
          jobId: FileUtils.generateJobId(),
          metadata: {
            ...job.metadata,
            repeatCount: currentCount + 1,
            created: new Date().toISOString(),
            startEarliestTime: intervalMs ? new Date(Date.now() + intervalMs).toISOString() : null
          }
        };

        this.jobRepository.createJob(newJob, 'jobs', JOB_STATES.PENDING);

        if (!intervalMs || intervalMs === 0) {
          this.triggerManager.createProcessingTrigger();
        } else {
          const nextTime = new Date(Date.now() + intervalMs);
          this.triggerManager.createProcessingTrigger({ scheduleType: 'once', isoTime: nextTime });
        }
      }
    }

    pickup(functionName, tag, keepFile = false) {
      return this.jobRepository.pickup(functionName, tag, keepFile);
    }

    peek(functionName, tag) {
      return this.jobRepository.peek(functionName, tag);
    }

    runWatchdog() {
      log('Running watchdog cleanup');
      return this.watchdogService.runHealthCheck();
    }

    getMetrics() {
      const quotaStats = this.watchdogService.getQuotaStats();
      const cacheStats = this.driveStorage.getCacheStats();

      return {
        triggers: {
          active: this.triggerManager.getActiveTriggerCount(),
          max: this.maxTriggers
        },
        quota: quotaStats,
        cache: cacheStats,
        jobs: {
          pending: this.stateManager.hasPendingJobs(), // preserved — boolean
          counts: this.getJobCounts()                   // new
        }
      };
    }

    // -------------------------------------------------------------------------
    // Management & Visibility API
    // -------------------------------------------------------------------------

    getActiveJobs() {
      const props = PropertiesService.getScriptProperties();
      const registryStr = props.getProperty('ActiveJobsRegistry') || '{}';
      try {
        return JSON.parse(registryStr);
      } catch (e) {
        log('[W] ActiveJobsRegistry parse error: ' + e.message);
        return {};
      }
    }

    getJobCounts() {
      const folderMap = {
        pending: 'jobs',
        running: 'locks',
        completed: 'results',
        failed: 'deadLetters'
      };
      const counts = {};
      for (const [label, folderType] of Object.entries(folderMap)) {
        try {
          const folder = this.driveStorage.getFolder(folderType);
          let count = 0;
          const files = folder.getFiles();
          while (files.hasNext()) { files.next(); count++; }
          counts[label] = count;
        } catch (e) {
          counts[label] = 0; // folder not yet initialized
        }
      }
      return counts;
    }

    getJobStatus(jobId) {
      const folders = ['jobs', 'locks', 'results', 'deadLetters'];
      for (const folderType of folders) {
        try {
          const folder = this.driveStorage.getFolder(folderType);
          const files = folder.getFiles();
          while (files.hasNext()) {
            const file = files.next();
            const parsed = FileUtils.parseJobFilename(file.getName());
            if (parsed && parsed.jobId === jobId) {
              const jobData = this.stateManager.getJobContent(file);
              return { state: parsed.state, folderType, filename: file.getName(), jobData };
            }
          }
        } catch (e) {
          // folder not yet initialized — skip
        }
      }
      return null;
    }

    retryJob(jobId) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) {
        throw new Error('Could not acquire lock for retryJob — another operation in progress');
      }
      try {
        const status = this.getJobStatus(jobId);
        if (!status || status.folderType !== 'deadLetters') {
          throw new Error('Job ' + jobId + ' not found in deadLetters');
        }
        const { jobData, filename } = status;
        const originalJob = jobData.metadata && jobData.metadata.originalJob;
        const sourceData = originalJob || jobData;

        if (!sourceData.steps || !Array.isArray(sourceData.steps) || sourceData.steps.length === 0) {
          throw new Error('Job ' + jobId + ' has no valid steps — cannot retry corrupt dead-letter entry');
        }

        const retryJobData = {
          ...sourceData,
          jobId: null,
          state: undefined,
          error: undefined,
          completedAt: undefined,
          metadata: {
            ...sourceData.metadata,
            retryOf: jobId,
            retryAt: new Date().toISOString()
          }
        };

        // Trash dead-letter file BEFORE creating new job (atomic-ish under LockService)
        const folder = this.driveStorage.getFolder('deadLetters');
        const files = folder.getFilesByName(filename);
        if (files.hasNext()) files.next().setTrashed(true);

        const file = this.jobRepository.createJob(retryJobData);
        const trigger = this.triggerManager.createProcessingTrigger();
        if (!trigger) {
          log('[W] retryJob: trigger limit reached — job queued but no trigger created; watchdog will recover');
        }
        log('Job retried | ' + JSON.stringify({ originalJobId: jobId, newFile: file.getName() }));
        return file;
      } finally {
        try { lock.releaseLock(); } catch (e) {}
      }
    }

    cancelPendingJob(jobId) {
      const folder = this.driveStorage.getFolder('jobs');
      const files = folder.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        const parsed = FileUtils.parseJobFilename(file.getName());
        if (parsed && parsed.jobId === jobId) {
          try {
            file.setTrashed(true);
          } catch (e) {
            // Job may have been moved by a concurrent caller — treat as cancelled
            log('[W] cancelPendingJob: setTrashed failed (likely already moved) | ' + JSON.stringify({ jobId, error: e.message }));
          }
          log('Cancelled pending job | ' + JSON.stringify({ jobId }));
          return true;
        }
      }
      return false;
    }

    timeRemaining() {
      if (!this.currentContext.startTime) {
        return null;
      }

      const elapsed = Date.now() - this.currentContext.startTime;
      return Math.max(0, this.maxRuntime - elapsed);
    }

    isCloseToTimeout() {
      const remaining = this.timeRemaining();
      return remaining !== null && remaining < 30000;
    }

    isCancellationRequested(triggerId) {
      return PropertiesService.getScriptProperties().getProperty(`cancel_${triggerId}`) !== null;
    }

    requestCancellation(triggerId) {
      PropertiesService.getScriptProperties().setProperty(`cancel_${triggerId}`, 'true');
      log('Cancellation requested | ' + JSON.stringify({ triggerId }));
    }

    clearCancellation(triggerId) {
      PropertiesService.getScriptProperties().deleteProperty(`cancel_${triggerId}`);
    }

    _withRegistryLock(opName, fn, lockTimeout = 3000) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(lockTimeout)) {
        log('[W] Could not acquire lock for ' + opName);
        return;
      }
      try {
        const props = PropertiesService.getScriptProperties();
        const registry = JSON.parse(props.getProperty('ActiveJobsRegistry') || '{}');
        fn(registry, props);
      } finally {
        try { lock.releaseLock(); } catch (e) {}
      }
    }

    registerActiveJob(triggerId, jobFileName) {
      this._withRegistryLock('registerActiveJob', (registry, props) => {
        registry[triggerId] = { jobFileName, startTime: new Date().toISOString(), currentFunction: null };
        props.setProperty('ActiveJobsRegistry', JSON.stringify(registry));
      });
    }

    unregisterActiveJob(triggerId) {
      this._withRegistryLock('unregisterActiveJob', (registry, props) => {
        delete registry[triggerId];
        if (Object.keys(registry).length > 0) {
          props.setProperty('ActiveJobsRegistry', JSON.stringify(registry));
        } else {
          props.deleteProperty('ActiveJobsRegistry');
        }
      });
    }

    updateActiveJobFunction(triggerId, functionPath) {
      this._withRegistryLock('updateActiveJobFunction', (registry, props) => {
        if (registry[triggerId]) {
          registry[triggerId].currentFunction = functionPath;
          props.setProperty('ActiveJobsRegistry', JSON.stringify(registry));
        }
      }, 1000);
    }

    rescheduleCurrentJobIfNeeded(newArgs) {
      if (!this.currentContext.triggerId) {
        throw new Error('No active trigger found in context');
      }

      if (this.isCancellationRequested(this.currentContext.triggerId)) {
        log('Cancellation requested, not rescheduling');
        return [true, null];
      }

      if (!this.isCloseToTimeout()) {
        return [false, null];
      }

      log('Close to timeout, rescheduling job');

      const props = PropertiesService.getScriptProperties();
      const registryStr = props.getProperty('ActiveJobsRegistry') || '{}';
      const registry = JSON.parse(registryStr);
      const jobRecord = registry[this.currentContext.triggerId];

      if (!jobRecord) {
        throw new Error(`No active job found for triggerId=${this.currentContext.triggerId}`);
      }

      const locksFolder = this.driveStorage.getFolder('locks');
      const lockFiles = locksFolder.getFilesByName(jobRecord.jobFileName);

      if (!lockFiles.hasNext()) {
        throw new Error(`Lock file not found: ${jobRecord.jobFileName}`);
      }

      const lockFile = lockFiles.next();
      const job = this.stateManager.getJobContent(lockFile);
      const currentIndex = job.metadata.resumeIndex || 0;

      if (Array.isArray(newArgs)) {
        job.steps[currentIndex].parameters = newArgs;
      }

      job.metadata.rescheduleCount = (job.metadata.rescheduleCount || 0) + 1;

      if (job.metadata.rescheduleCount > JobScheduler.MAX_RESCHEDULE_RETRIES) {
        log('[E] Job exceeded max reschedule attempts | ' + JSON.stringify({ count: job.metadata.rescheduleCount, max: JobScheduler.MAX_RESCHEDULE_RETRIES }));

        this.handleJobError(
          lockFile,
          job,
          new Error(`Exceeded maximum reschedule attempts (${JobScheduler.MAX_RESCHEDULE_RETRIES})`),
          currentIndex,
          new Date().toISOString(),
          0
        );

        return [true, null];
      }

      job.metadata.created = new Date().toISOString();
      const newFile = this.jobRepository.createJob(job, 'jobs', JOB_STATES.PENDING);

      this.triggerManager.createProcessingTrigger({ scheduleType: 'after', offsetMs: 1000 });

      lockFile.setTrashed(true);
      this.unregisterActiveJob(this.currentContext.triggerId);

      log('Job rescheduled | ' + JSON.stringify({ attempt: job.metadata.rescheduleCount, newFilename: newFile.getName() }));

      return [true, newFile.getName()];
    }
  }

  JobScheduler.MAX_RESCHEDULE_RETRIES = 15;

  class JobBuilder {
    constructor(scheduler) {
      if (!(scheduler instanceof JobScheduler)) {
        throw new Error('JobBuilder requires a JobScheduler instance');
      }

      this.scheduler = scheduler;
      this.job = {
        jobId: FileUtils.generateJobId(),
        steps: [],
        state: JOB_STATES.PENDING,
        metadata: {
          created: new Date().toISOString(),
          tags: []
        }
      };
    }

    thenAfter(functionPath, ...args) {
      this.scheduler.jobExecutor.validateFunctionPath(functionPath);

      this.job.steps.push({
        functionPath: functionPath,
        parameters: args
      });

      return this;
    }

    withOptions(options) {
      if (options.storeIntermediate !== undefined) {
        this.job.metadata.storeIntermediate = options.storeIntermediate;
      }

      if (options.maxRetries !== undefined) {
        this.job.metadata.maxRetries = options.maxRetries;
      }

      if (options.description) {
        this.job.metadata.description = options.description.substring(0, 50);
      }

      if (options.tags && Array.isArray(options.tags)) {
        this.job.metadata.tags = options.tags;
      }

      return this;
    }

    withDelay(delayMs) {
      this.job.metadata.startEarliestTime = new Date(Date.now() + delayMs).toISOString();
      return this;
    }

    withRepeat(options) {
      this.job.metadata.repeat = {
        mode: options.mode || 'count',
        count: options.count || 1,
        intervalMs: options.intervalMs || 0
      };
      return this;
    }

    withWeeklySchedule(daysOfWeek) {
      this.job.metadata.weeklySchedule = {
        daysOfWeek: daysOfWeek
      };
      return this;
    }

    schedule() {
      if (this.job.steps.length === 0) {
        throw new Error('Job must have at least one step');
      }

      // folderType defaults to 'jobs', state defaults to JOB_STATES.PENDING
      const file = this.scheduler.jobRepository.createJob(this.job);

      const hasDelay = this.job.metadata.startEarliestTime &&
        new Date(this.job.metadata.startEarliestTime).getTime() > Date.now();

      if (!hasDelay) {
        this.scheduler.triggerManager.createProcessingTrigger();
      } else {
        const delayTime = new Date(this.job.metadata.startEarliestTime);
        this.scheduler.triggerManager.createProcessingTrigger({ scheduleType: 'once', isoTime: delayTime });
      }

      return file;
    }
  }

  module.exports = {
    JobScheduler,
    JobBuilder,
    NoResultsFoundError,
    JobValidationError,
    FunctionPathError,
    JobExecutionError
  };
}

__defineModule__(_main);