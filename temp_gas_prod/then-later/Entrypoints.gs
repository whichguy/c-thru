// then-later/Entrypoints.gs - Global trigger entry points for the scheduler

function _main(module, exports, log) {

  // Shared context for global trigger functions
  let _globalContext = {
    triggerId: null,
    startTime: null,
    scheduler: null
  };

  /**
   * Main trigger handler for processing the job queue.
   * Called by time-based triggers created by TriggerManager.
   */
  function processQueue(e) {
    const triggerUid = (e && e.triggerUid) ? e.triggerUid : 'manual-execution';
    log('processQueue() start | triggerUid=' + triggerUid);

    try {
      const { JobScheduler } = require('then-later/core/JobScheduler');
      const scheduler = new JobScheduler();
      _globalContext.scheduler = scheduler;
      _globalContext.triggerId = triggerUid;
      _globalContext.startTime = Date.now();

      scheduler.processQueue(triggerUid);
      log('processQueue() done | triggerUid=' + triggerUid);
    } catch (error) {
      log('Queue processing failed: ' + error.message);
      throw error;
    } finally {
      _globalContext.scheduler = null;
      _globalContext.triggerId = null;
      _globalContext.startTime = null;
    }
  }

  function makeScheduler() {
    const { JobScheduler } = require('then-later/core/JobScheduler');
    return new JobScheduler();
  }

  /**
   * Watchdog cleanup function (runs every 6 hours).
   */
  function watchdogCleanup() {
    log('watchdogCleanup() entry point called');
    try {
      const stats = makeScheduler().runWatchdog();
      log('Watchdog cleanup completed: ' + JSON.stringify(stats));
      return stats;
    } catch (error) {
      log('Watchdog cleanup failed: ' + error.message);
      throw error;
    }
  }

  /**
   * Checks if cancellation was requested for the current trigger.
   */
  function isCancelRequested() {
    if (!_globalContext.triggerId || !_globalContext.scheduler) return false;
    return _globalContext.scheduler.isCancellationRequested(_globalContext.triggerId);
  }

  /**
   * Returns remaining execution time for current trigger in ms, or null.
   */
  function timeRemaining() {
    if (!_globalContext.triggerId || !_globalContext.startTime || !_globalContext.scheduler) return null;
    return _globalContext.scheduler.timeRemaining();
  }

  /**
   * Reschedules the current job if close to timeout.
   */
  function rescheduleCurrentJobIfNeed(newArgs) {
    log('rescheduleCurrentJobIfNeed() entry point called');
    if (!_globalContext.triggerId || !_globalContext.scheduler) {
      throw new Error('No active trigger found in global context');
    }
    return _globalContext.scheduler.rescheduleCurrentJobIfNeeded(newArgs);
  }

  /**
   * Cancels a trigger by its ID.
   */
  function cancelTriggerById(triggerId) {
    log('cancelTriggerById() entry point called');
    makeScheduler().requestCancellation(triggerId);
  }

  /**
   * Idempotent watchdog trigger install — creates a 6h recurring trigger for
   * watchdogCleanup if one doesn't already exist. Also initializes Drive folders
   * on first run.
   */
  function installWatchdogTrigger() {
    log('installWatchdogTrigger() called');

    // Initialize Drive folder structure (idempotent)
    try {
      const { JobScheduler } = require('then-later/core/JobScheduler');
      new JobScheduler().driveStorage.initialize();
    } catch (e) {
      log('Drive initialize (already exists): ' + e.message);
    }

    // Check for existing watchdog trigger
    const triggers = ScriptApp.getProjectTriggers();
    for (const t of triggers) {
      if (t.getHandlerFunction() === 'watchdogCleanup') {
        log('Watchdog trigger already exists, skipping');
        return;
      }
    }

    ScriptApp.newTrigger('watchdogCleanup')
      .timeBased()
      .everyHours(6)
      .create();
    log('Watchdog trigger installed (6h interval)');
  }

  /**
   * Returns an array of scheduler job completion notifications to surface in
   * the sidebar. Marks each returned notification as shown (SCHEDULER_NOTIFY_{id})
   * so it is not re-emitted on subsequent polls.
   *
   * Uses a script lock to prevent duplicate notifications from concurrent polls.
   * Returns [] immediately when no SCHEDULER_JOB_* keys exist (zero Drive calls).
   *
   * @returns {Array<{jobId, description, status, error?}>}
   */
  function getActiveJobs() {
    return makeScheduler().getActiveJobs();
  }

  function getJobCounts() {
    return makeScheduler().getJobCounts();
  }

  function getJobStatus(jobId) {
    return makeScheduler().getJobStatus(jobId);
  }

  function retryJob(jobId) {
    return makeScheduler().retryJob(jobId);
  }

  function cancelPendingJob(jobId) {
    return makeScheduler().cancelPendingJob(jobId);
  }

  /**
   * Schedule a GAS function to run asynchronously via the then-later queue.
   * @param {string} functionPath - Module path + exported function name
   * @param {Array} [args=[]] - Arguments to pass to the function
   * @param {number} [delayMs=0] - Optional delay before execution in ms
   * @returns {{ jobId: string }}
   */
  function scheduleTask(functionPath, args, delayMs) {
    log('scheduleTask called: ' + functionPath);
    const scheduler = makeScheduler();
    let builder = scheduler.create(functionPath, ...(args || []));
    if (delayMs > 0) builder = builder.withDelay(delayMs);
    const file = builder.schedule();
    var fileMatch = file.getName().match(/^[A-Z]+-([^-]+)/);
    return { jobId: fileMatch ? fileMatch[1] : file.getName() };
  }

  /**
   * Schedules an arbitrary JavaScript code string to run asynchronously via then-later.
   *
   * Calls compileCheck before queuing so syntax errors surface immediately, not at
   * execution time. Uses functionPath 'ScriptRunner.runScript' (not the module path)
   * because the path resolver only accepts word-char dotted paths.
   *
   * @param {string} code - JavaScript code to execute (max 50,000 chars)
   * @param {Object} [options]
   * @param {string} [options.description] - Label for task listing (max 50 chars)
   * @param {number} [options.delayMs] - Delay before first run in ms
   * @param {number} [options.repeatIntervalMs] - Ms between repeats; omit for one-shot
   * @param {number} [options.repeatCount] - Times to repeat; omit for infinite when interval set
   * @param {number[]} [options.weeklyDays] - [0..6]; job only executes on those days of week
   * @returns {{ jobId: string }} Short job ID (use with rescheduleTask / cancelPendingJob)
   */
  function scheduleScript(code, options) {
    if (typeof code !== 'string' || !code) {
      throw new Error('scheduleScript: code must be a non-empty string');
    }
    if (code.length > 50000) {
      throw new Error('scheduleScript: code exceeds 50,000 character limit');
    }

    // Syntax-check before queuing — fails fast at schedule time, not execution time.
    require('sheets-chat/ScriptRunner').compileCheck(code);

    options = options || {};
    var description = options.description;
    var delayMs = options.delayMs || 0;
    var repeatIntervalMs = options.repeatIntervalMs || 0;
    var repeatCount = options.repeatCount;
    var weeklyDays = options.weeklyDays;

    var scheduler = makeScheduler();
    var builder = scheduler.create('ScriptRunner.runScript', code);

    var withOptionsObj = { tags: ['script'] };
    if (description) withOptionsObj.description = description;
    builder = builder.withOptions(withOptionsObj);

    if (delayMs > 0) builder = builder.withDelay(delayMs);

    if (repeatIntervalMs > 0) {
      var repeatConfig = {
        mode: (repeatCount > 0) ? 'count' : 'infinite',
        intervalMs: repeatIntervalMs
      };
      if (repeatCount > 0) repeatConfig.count = repeatCount;
      builder = builder.withRepeat(repeatConfig);
    }

    if (Array.isArray(weeklyDays) && weeklyDays.length > 0) {
      builder = builder.withWeeklySchedule(weeklyDays);
    }

    var file = builder.schedule();

    // Return the short jobId from the filename (e.g. 'lh34kx2abc' from
    // 'PENDING-lh34kx2abc.json'). cancelPendingJob and getJobStatus both
    // expect this short form — NOT the full filename.
    var fileMatch = file.getName().match(/^[A-Z]+-([^-]+)/);
    var jobId = fileMatch ? fileMatch[1] : file.getName();
    return { jobId: jobId };
  }

  /**
   * Reschedules a pending script job with new timing options.
   *
   * Uses cancel+recreate to avoid Drive file race conditions. Issues a NEW jobId —
   * callers must discard the old jobId and use the returned one for all future ops.
   *
   * @param {string} jobId - Short job ID from scheduleScript
   * @param {Object} [options] - Same timing options as scheduleScript (description excluded)
   * @returns {{ jobId: string }} New short job ID — replace any stored reference to old ID
   */
  function rescheduleTask(jobId, options) {
    log('rescheduleTask called: ' + jobId);
    if (typeof jobId !== 'string' || !jobId) {
      throw new Error('rescheduleTask: jobId must be a non-empty string');
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) {
      throw new Error('rescheduleTask: could not acquire lock — another reschedule in progress');
    }

    try {
      var scheduler = makeScheduler();
      var status = scheduler.getJobStatus(jobId);

      if (!status) throw new Error('Job not found: ' + jobId);
      if (status.state !== 'PENDING') {
        throw new Error('Job is not pending: ' + status.state);
      }

      // Extract the original code from the pending job.
      // steps[0].parameters[0] is the code string passed to ScriptRunner.runScript.
      var steps = status.jobData.steps;
      if (!Array.isArray(steps) || steps.length === 0 || !steps[0]) {
        throw new Error('rescheduleTask: job ' + jobId + ' has no steps — not a script job');
      }
      var code = steps[0].parameters[0];
      if (typeof code !== 'string' || !code) {
        throw new Error('rescheduleTask: could not extract code from job ' + jobId);
      }

      // Preserve original description unless caller explicitly provides a new one
      var rescheduleOptions = Object.assign({}, options || {});
      if (!rescheduleOptions.description) {
        var origDesc = status.jobData.metadata && status.jobData.metadata.description;
        if (origDesc) rescheduleOptions.description = origDesc;
      }

      // Cancel+recreate: avoids Drive file race (no in-place rename).
      // Trade-off: new jobId is issued; caller must update any stored reference.
      scheduler.cancelPendingJob(jobId);
      return scheduleScript(code, rescheduleOptions);
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Lists completed and failed script job results from the then-later Drive store.
   *
   * Capped at 50 most recent results (by creation time, descending). Iterates both
   * results/ and deadLetters/ folders. Cancelled pending jobs do NOT appear here
   * (they are trashed, not moved to deadLetters).
   *
   * Dual-filter: tags includes 'script' (primary); originalJob.steps[0].functionPath fallback.
   *
   * @returns {Array<{ jobId, description, status, firedAt?, durationMs?, result?, error? }>}
   */
  function listScriptResults() {
    var scheduler = makeScheduler();
    var entries = [];

    var folders = ['results', 'deadLetters'];
    for (var fi = 0; fi < folders.length; fi++) {
      var folderType = folders[fi];
      try {
        var folder = scheduler.driveStorage.getFolder(folderType);
        var files = folder.getFiles();

        while (files.hasNext()) {
          var file = files.next();

          // Parse short jobId from filename (e.g. 'lh34kx2abc' from 'SUCCESS-lh34kx2abc.json')
          var filenameMatch = file.getName().match(/^[A-Z]+-([^-]+)/);
          if (!filenameMatch) continue;
          var fileJobId = filenameMatch[1];

          var data;
          try {
            data = JSON.parse(file.getBlob().getDataAsString());
          } catch (e) { continue; }

          // Dual-filter: tag primary, functionPath fallback
          var originalJob = data.metadata && data.metadata.originalJob;
          var tags = originalJob && originalJob.metadata && originalJob.metadata.tags;
          var functionPath = originalJob && originalJob.steps && originalJob.steps[0] && originalJob.steps[0].functionPath;
          var isScript = (Array.isArray(tags) && tags.indexOf('script') !== -1) ||
                         functionPath === 'ScriptRunner.runScript';
          if (!isScript) continue;

          var entry = {
            jobId: fileJobId,
            description: (originalJob && originalJob.metadata && originalJob.metadata.description) || '',
            status: data.state === 'SUCCESS' ? 'completed' : 'failed'
          };

          if (data.state === 'SUCCESS' && Array.isArray(data.results) && data.results[0]) {
            var stepResult = data.results[0];
            entry.firedAt = stepResult.firedAt;
            entry.durationMs = stepResult.durationMs;
            entry.result = stepResult.result;
          }

          if (data.error && data.error.message) {
            entry.error = data.error.message;
          }

          // Internal sort key — removed before return
          entry._created = (originalJob && originalJob.metadata && originalJob.metadata.created) || '0000-01-01T00:00:00Z';
          entries.push(entry);
        }
      } catch (e) {
        log('[W] listScriptResults: error reading folder ' + folderType + ': ' + e.message);
      }
    }

    // Sort newest first, cap at 50
    entries.sort(function(a, b) { return b._created < a._created ? -1 : b._created > a._created ? 1 : 0; });
    if (entries.length > 50) entries = entries.slice(0, 50);

    return entries.map(function(e) { delete e._created; return e; });
  }

  /**
   * Retrieves the result of a specific completed or failed script job by jobId.
   *
   * Searches results/ and deadLetters/ folders for a file containing the jobId.
   * Returns null if the job is still pending or not found (caller should poll with
   * getJobStatus for pending jobs).
   *
   * Concurrency note: read-only scan; GAS trigger execution serializes concurrent
   * processQueue runs, so no explicit lock is needed.
   *
   * @param {string} jobId - Short job ID returned by scheduleScript
   * @returns {{ jobId, description, status, firedAt?, durationMs?, result?, error? } | null}
   */
  function getScriptResult(jobId) {
    if (!jobId || typeof jobId !== 'string') {
      throw new Error('getScriptResult: jobId must be a non-empty string');
    }
    var scheduler = makeScheduler();
    var folders = ['results', 'deadLetters'];
    for (var fi = 0; fi < folders.length; fi++) {
      var folderType = folders[fi];
      try {
        var folder = scheduler.driveStorage.getFolder(folderType);
        var files = folder.getFiles();
        while (files.hasNext()) {
          var file = files.next();
          if (!file.getName().includes(jobId)) continue;
          var data;
          try { data = JSON.parse(file.getBlob().getDataAsString()); } catch (e) { continue; }
          var originalJob = data.metadata && data.metadata.originalJob;
          var entry = {
            jobId: jobId,
            description: (originalJob && originalJob.metadata && originalJob.metadata.description) || '',
            status: data.state === 'SUCCESS' ? 'completed' : 'failed'
          };
          if (data.state === 'SUCCESS' && Array.isArray(data.results) && data.results[0]) {
            var sr = data.results[0];
            entry.firedAt = sr.firedAt;
            entry.durationMs = sr.durationMs;
            entry.result = sr.result;
          }
          if (data.error && data.error.message) entry.error = data.error.message;
          log('[getScriptResult] found ' + jobId + ' in ' + folderType);
          return entry;
        }
      } catch (e) {
        log('[W] getScriptResult: error reading folder ' + folderType + ': ' + e.message);
      }
    }
    return null; // still pending/running, or not found
  }

  function getCompletedJobNotifications() {
    const props = PropertiesService.getScriptProperties();
    const allProps = props.getProperties();

    // Fast path: no tracked jobs → zero Drive API calls
    const jobEntries = Object.entries(allProps).filter(([k]) => k.startsWith('SCHEDULER_JOB_'));
    if (jobEntries.length === 0) return [];

    // Use lock to prevent duplicate notifications from concurrent sidebar polls
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) {
      log('getCompletedJobNotifications: could not acquire lock, skipping');
      return [];
    }

    try {
      const notifications = [];
      const scheduler = makeScheduler();

      for (const [key, value] of jobEntries) {
        try {
          const jobId = key.substring('SCHEDULER_JOB_'.length);
          const notifyKey = 'SCHEDULER_NOTIFY_' + jobId;

          // Skip already-shown notifications
          if (props.getProperty(notifyKey)) continue;

          // Check Drive for completed/failed status
          let status = null;
          let errorMsg = null;

          try {
            const resultsFolder = scheduler.driveStorage.getFolder('results');
            const files = resultsFolder.getFiles();
            while (files.hasNext()) {
              if (files.next().getName().includes(jobId)) {
                status = 'completed';
                break;
              }
            }
          } catch (e) { /* folder not yet initialized */ }

          if (!status) {
            try {
              const deadFolder = scheduler.driveStorage.getFolder('deadLetters');
              const files = deadFolder.getFiles();
              while (files.hasNext()) {
                const f = files.next();
                if (f.getName().includes(jobId)) {
                  status = 'failed';
                  try {
                    const data = JSON.parse(f.getBlob().getDataAsString());
                    errorMsg = (data.error && data.error.message) || (typeof data.error === 'string' ? data.error : null) || 'Task failed';
                  } catch (e) {
                    errorMsg = 'Task failed';
                  }
                  break;
                }
              }
            } catch (e) { /* folder not yet initialized */ }
          }

          if (status) {
            // Mark as shown before adding to results (inside lock)
            props.setProperty(notifyKey, 'shown');

            const meta = JSON.parse(value);
            const notification = {
              jobId,
              description: meta.description || meta.task_key || jobId,
              status
            };
            if (errorMsg) notification.error = errorMsg;
            notifications.push(notification);
          }
        } catch (e) {
          log('getCompletedJobNotifications: error processing job entry: ' + e.message);
        }
      }

      return notifications;
    } finally {
      lock.releaseLock();
    }
  }

  module.exports = {
    processQueue,
    watchdogCleanup,
    isCancelRequested,
    timeRemaining,
    rescheduleCurrentJobIfNeed,
    cancelTriggerById,
    installWatchdogTrigger,
    getCompletedJobNotifications,
    getActiveJobs,
    getJobCounts,
    getJobStatus,
    retryJob,
    cancelPendingJob,
    scheduleTask,
    scheduleScript,
    rescheduleTask,
    listScriptResults,
    getScriptResult,
    // loadNow required: __global__ registers trigger entry points on globalThis at parse time
    __global__: {
      processQueue,
      watchdogCleanup,
      isCancelRequested,
      timeRemaining,
      rescheduleCurrentJobIfNeed,
      cancelTriggerById
    }
  };
}

__defineModule__(_main, true);
