/**
 * SchedulerFlows.integration.test.gs - Integration tests for scheduler trigger flows
 *
 * Performance design: normal/error/delayed path tests share a single processQueue
 * call via before/after hooks, reducing Drive-backed GAS time from ~102s to ~36s.
 *
 * Tests (real Drive + ScriptProperties):
 * - batch: normal job → SUCCESS in results, error job → FAILED in deadLetters,
 *          delayed job → stays in jobs (single processQueue covers all three)
 * - processQueue cancelled: exits early when cancel key pre-seeded; no Drive job work
 * - watchdogCleanup stale lock: runs without error; fresh lock file is not removed
 * - watchdogCleanup ScriptProperties: cleans up orphaned cancel_* key
 * - end-to-end schedule → pickup: result is a number array, meta.success === true
 *
 * Note: cleanupProcessQueueTriggers() silently swallows ScriptApp errors since
 * script.scriptapp scope is not available in the web app exec context.
 */

function _main(module, exports, log) {

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var JobSchedulerModule = require('then-later/core/JobScheduler');
  var Entrypoints = require('then-later/Entrypoints');

  var describe = mocha.describe;
  var it = mocha.it;
  var before = mocha.beforeAll;
  var after = mocha.afterAll;
  var expect = chai.expect;

  var JobScheduler = JobSchedulerModule.JobScheduler;

  // ============================================================================
  // Helpers
  // ============================================================================

  function cleanupJobFromDrive(scheduler, jobId) {
    ['jobs', 'locks', 'results', 'deadLetters'].forEach(function(type) {
      try {
        var folder = scheduler.driveStorage.getFolder(type);
        var files = folder.getFiles();
        while (files.hasNext()) {
          var file = files.next();
          if (file.getName().indexOf(jobId) !== -1) {
            try { file.setTrashed(true); } catch (e) {}
          }
        }
      } catch (e) {}
    });
  }

  function cleanupProcessQueueTriggers() {
    try {
      ScriptApp.getProjectTriggers().forEach(function(t) {
        if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
      });
    } catch (e) {}
  }

  function folderContainsJob(scheduler, folderType, jobId) {
    try {
      var folder = scheduler.driveStorage.getFolder(folderType);
      var files = folder.getFiles();
      while (files.hasNext()) {
        if (files.next().getName().indexOf(jobId) !== -1) return true;
      }
    } catch (e) {}
    return false;
  }

  // ============================================================================
  // Suite 0: ENV — pre-test environment verification
  // ============================================================================

  describe('SchedulerFlows [ENV] — pre-test environment verification', function() {

    it('[ENV-01] Drive folders are accessible', function() {
      log('→ [ENV-01] check jobs/locks/results/deadLetters accessible');
      var scheduler = new JobScheduler();
      var errors = [];
      ['jobs', 'locks', 'results', 'deadLetters'].forEach(function(t) {
        try { scheduler.driveStorage.getFolder(t); }
        catch (e) { errors.push(t + ': ' + e.message); }
      });
      log('← [ENV-01] errors=' + JSON.stringify(errors));
      expect(errors).to.deep.equal([]);
    });

    it('[ENV-02] stale sched-* Drive files from previous runs cleaned', function() {
      log('→ [ENV-02] scan all folders for sched-* files');
      var scheduler = new JobScheduler();
      var removed = [];
      ['jobs', 'locks', 'results', 'deadLetters'].forEach(function(type) {
        try {
          var folder = scheduler.driveStorage.getFolder(type);
          var files = folder.getFiles();
          while (files.hasNext()) {
            var f = files.next();
            if (f.getName().indexOf('sched-') !== -1) {
              try { f.setTrashed(true); removed.push(f.getName()); } catch (e) {}
            }
          }
        } catch (e) {}
      });
      log('← [ENV-02] removed=' + removed.length + ' stale files');
      expect(true).to.equal(true);
    });

    it('[ENV-03] stale sched-* ScriptProperties keys from previous runs cleaned', function() {
      log('→ [ENV-03] scan ScriptProperties for cancel_sched-* keys');
      var props = PropertiesService.getScriptProperties();
      var all = props.getProperties();
      var removed = 0;
      Object.keys(all).forEach(function(key) {
        if (key.indexOf('cancel_sched-') === 0) {
          props.deleteProperty(key);
          removed++;
        }
      });
      log('← [ENV-03] removed=' + removed + ' stale keys');
      expect(true).to.equal(true);  // informational
    });

    it('[ENV-04] processQueue trigger count is within quota', function() {
      log('→ [ENV-04] count processQueue triggers');
      try {
        var pqCount = 0;
        ScriptApp.getProjectTriggers().forEach(function(t) {
          if (t.getHandlerFunction() === 'processQueue') pqCount++;
        });
        log('← [ENV-04] pqCount=' + pqCount + ' (limit=13)');
        expect(pqCount).to.be.most(13);  // maxTriggers limit
      } catch (e) {
        log('← [ENV-04] ScriptApp not available: ' + e.message);
        // ScriptApp not available in web app exec context — skip assertion
      }
    });

  });

  // ============================================================================
  // Suite 1: batch processQueue — one call processes normal + error + delayed
  // ============================================================================

  describe('SchedulerFlows [BATCH] — processQueue batch', function() {

    var scheduler;
    var normalJobId;
    var errorJobId;
    var delayedJobId;

    before(function() {
      scheduler = new JobScheduler();

      // Normal job: Math.random → should land in results
      var normalBuilder = scheduler.create('Math.random');
      normalJobId = normalBuilder.job.jobId;
      normalBuilder.schedule();

      // Error job: nonexistent function → should land in deadLetters
      // Bypass create() validation: use jobRepository directly
      errorJobId = 'sched-batch-err-' + Date.now();
      scheduler.jobRepository.createJob({
        jobId: errorJobId,
        steps: [{ functionPath: 'nonExistentFunctionForSchedulerTest123', parameters: [] }],
        metadata: { description: 'Error path test', created: new Date().toISOString() }
      });

      // Delayed job: 1-hour future startEarliestTime → should stay in jobs
      var delayedBuilder = scheduler.create('Math.random').withDelay(3600000);
      delayedJobId = delayedBuilder.job.jobId;
      delayedBuilder.schedule();

      var batchTriggerUid = 'sched-batch-' + Date.now();
      log('→ [BATCH before] normalJobId=' + normalJobId + ' errorJobId=' + errorJobId + ' delayedJobId=' + delayedJobId + ' triggerUid=' + batchTriggerUid);

      // Single processQueue call processes normal + error, skips delayed.
      try {
        Entrypoints.processQueue({ triggerUid: batchTriggerUid });
      } catch (e) {
        log('← [BATCH before] processQueue threw (belt-and-suspenders): ' + e.message);
      }

      log('← [BATCH before] processQueue done | normalInResults=' + folderContainsJob(scheduler, 'results', normalJobId) +
          ' errorInDead=' + folderContainsJob(scheduler, 'deadLetters', errorJobId) +
          ' delayedInJobs=' + folderContainsJob(scheduler, 'jobs', delayedJobId));
    });

    after(function() {
      log('→ [BATCH after] cleanup jobs');
      if (normalJobId && scheduler) cleanupJobFromDrive(scheduler, normalJobId);
      if (errorJobId && scheduler) cleanupJobFromDrive(scheduler, errorJobId);
      if (delayedJobId && scheduler) cleanupJobFromDrive(scheduler, delayedJobId);
      cleanupProcessQueueTriggers();
      log('← [BATCH after] done');
    });

    it('normal Math.random job lands in results folder', function() {
      log('→ [BATCH normal] check normalJobId=' + normalJobId + ' in results');
      var inResults = folderContainsJob(scheduler, 'results', normalJobId);
      expect(inResults).to.equal(true);
      log('← [BATCH normal] inResults=' + inResults);
    });

    it('job with bad function path lands in deadLetters folder', function() {
      log('→ [BATCH error] check errorJobId=' + errorJobId + ' in deadLetters');
      var inDead = folderContainsJob(scheduler, 'deadLetters', errorJobId);
      expect(inDead).to.equal(true);
      log('← [BATCH error] inDead=' + inDead);
    });

    it('job with 1-hour delay stays in jobs folder', function() {
      log('→ [BATCH delayed] check delayedJobId=' + delayedJobId + ' stays in jobs');
      var inJobs = folderContainsJob(scheduler, 'jobs', delayedJobId);
      var inResults = folderContainsJob(scheduler, 'results', delayedJobId);
      var inDead = folderContainsJob(scheduler, 'deadLetters', delayedJobId);
      expect(inJobs).to.equal(true);
      expect(inResults).to.equal(false);
      expect(inDead).to.equal(false);
      log('← [BATCH delayed] inJobs=' + inJobs + ' inResults=' + inResults + ' inDead=' + inDead);
    });

  });

  // ============================================================================
  // Suite 2: cancelled — processQueue exits before any Drive job processing
  // ============================================================================

  describe('SchedulerFlows [CANCEL] — processQueue exits early when cancelled', function() {

    it('pre-seeded cancel key causes processQueue to return without processing', function() {
      var scheduler = new JobScheduler();
      var builder = scheduler.create('Math.random');
      var jobId = builder.job.jobId;
      builder.schedule();
      var triggerUid = 'sched-cancel-' + Date.now();
      PropertiesService.getScriptProperties().setProperty('cancel_' + triggerUid, 'true');
      log('→ [CANCEL] jobId=' + jobId + ' triggerUid=' + triggerUid + ' cancel key pre-seeded');
      try {
        var threw = false;
        try {
          Entrypoints.processQueue({ triggerUid: triggerUid });
        } catch (e) {
          threw = true;
          log('← [CANCEL] processQueue threw: ' + e.message);
        }
        var inResults = folderContainsJob(scheduler, 'results', jobId);
        var inDead = folderContainsJob(scheduler, 'deadLetters', jobId);
        log('← [CANCEL] threw=' + threw + ' inResults=' + inResults + ' inDead=' + inDead);
        expect(threw).to.equal(false);
        expect(inResults).to.equal(false);
        expect(inDead).to.equal(false);
      } finally {
        cleanupJobFromDrive(scheduler, jobId);
        PropertiesService.getScriptProperties().deleteProperty('cancel_' + triggerUid);
        cleanupProcessQueueTriggers();
      }
    });

  });

  // ============================================================================
  // Suite 3: watchdogCleanup — no processQueue needed
  // ============================================================================

  describe('SchedulerFlows [WDLOCK] — watchdogCleanup stale lock removal', function() {

    it('watchdogCleanup runs without error; fresh lock file is not removed', function() {
      var scheduler = new JobScheduler();
      var jobId = 'sched-wdlock-' + Date.now();
      var lockFilename = 'RUNNING-' + jobId + '.json';
      var lockFile = null;
      log('→ [WDLOCK] create fresh lock file | jobId=' + jobId + ' file=' + lockFilename);
      try {
        lockFile = scheduler.driveStorage.getFolder('locks')
          .createFile(lockFilename, '{}', 'application/json');

        var stats = null;
        var watchdogError = null;
        try {
          stats = Entrypoints.watchdogCleanup();
        } catch (e) {
          watchdogError = e;
        }

        if (watchdogError && watchdogError.message &&
            watchdogError.message.indexOf('ScriptApp') >= 0) {
          var stillPresent = folderContainsJob(scheduler, 'locks', jobId);
          log('← [WDLOCK] ScriptApp unavailable | freshLockStillPresent=' + stillPresent);
          expect(stillPresent).to.equal(true);
        } else if (watchdogError) {
          throw watchdogError;
        } else {
          var stillPresent2 = folderContainsJob(scheduler, 'locks', jobId);
          log('← [WDLOCK] stats=' + JSON.stringify(stats) + ' freshLockStillPresent=' + stillPresent2);
          expect(stats).to.be.an('object');
          expect(stats.staleLocksRemoved).to.be.a('number');
          expect(stats.staleLocksRemoved).to.be.least(0);
          expect(stillPresent2).to.equal(true);
        }
      } finally {
        if (lockFile) {
          try { lockFile.setTrashed(true); } catch (e) {}
        }
        cleanupProcessQueueTriggers();
      }
    });

  });

  describe('SchedulerFlows [WDPROPS] — watchdogCleanup ScriptProperties cleanup', function() {

    it('orphaned cancel_* key for a non-existent trigger is removed by watchdogCleanup', function() {
      var staleKey = 'cancel_sched-wdprops-stale';
      PropertiesService.getScriptProperties().setProperty(staleKey, 'true');
      log('→ [WDPROPS] seed staleKey=' + staleKey + ' then run watchdogCleanup()');
      try {
        var watchdogError = null;
        try {
          Entrypoints.watchdogCleanup();
        } catch (e) {
          watchdogError = e;
        }

        if (watchdogError && watchdogError.message &&
            watchdogError.message.indexOf('ScriptApp') >= 0) {
          PropertiesService.getScriptProperties().deleteProperty(staleKey);
          log('← [WDPROPS] ScriptApp unavailable; manually cleaned key');
        } else if (watchdogError) {
          throw watchdogError;
        } else {
          var remaining = PropertiesService.getScriptProperties().getProperty(staleKey);
          log('← [WDPROPS] remaining key val=' + remaining + ' (expected null)');
          expect(remaining).to.equal(null);
        }
      } finally {
        PropertiesService.getScriptProperties().deleteProperty(staleKey);
        cleanupProcessQueueTriggers();
      }
    });

  });

  // ============================================================================
  // Suite 4: end-to-end pickup
  // ============================================================================

  describe('SchedulerFlows [E2E] — end-to-end: schedule → pickup', function() {

    it('scheduled Math.random job produces a numeric result via pickup', function() {
      var scheduler = new JobScheduler();
      var builder = scheduler.create('Math.random');
      var tag = builder.job.jobId;
      builder.job.metadata.tags = [tag];
      builder.schedule();
      var triggerUid = 'sched-e2e-' + tag;
      log('→ [E2E] schedule Math.random | tag=' + tag + ' triggerUid=' + triggerUid);
      try {
        Entrypoints.processQueue({ triggerUid: triggerUid });

        var pickupResult = scheduler.pickup('Math.random', tag);
        var results = pickupResult[0];
        var meta = pickupResult[1];

        log('← [E2E] results[0]=' + results[0] + ' meta.success=' + meta.success);
        expect(Array.isArray(results)).to.equal(true);
        expect(results[0]).to.be.a('number');
        expect(meta.success).to.equal(true);
      } finally {
        cleanupJobFromDrive(scheduler, tag);
        cleanupProcessQueueTriggers();
      }
    });

  });

}

__defineModule__(_main);
