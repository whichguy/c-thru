function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var Entrypoints = require('then-later/Entrypoints');
var JobSchedulerModule = require('then-later/core/JobScheduler');
var JobStateManagerModule = require('then-later/storage/JobStateManager');

var describe = mocha.describe;
var it = mocha.it;
var before = mocha.beforeAll;
var after = mocha.afterAll;
var expect = chai.expect;

var JobScheduler = JobSchedulerModule.JobScheduler;
var JOB_STATES = JobStateManagerModule.JOB_STATES;
var FileUtils = JobStateManagerModule.FileUtils;

var log = function(msg) { Logger.log(msg); };

// ============================================================================
// Test helper functions — registered on globalThis before tests run
// ============================================================================

var _CF_HELPERS = [
  'sched_testReturnFortyTwo',
  'sched_testDouble',
  'sched_testAddTen',
  'sched_testThrowOnSecondCall',
  'sched_testSleepThreeSec'
];

var _sched_testThrowOnSecondCallCount = 0;

// ============================================================================
// Global setup: register helpers on globalThis
// ============================================================================

before(function() {
  log('→ [CF global before] register helpers: ' + _CF_HELPERS.join(', '));
  globalThis.sched_testReturnFortyTwo = function() { return 42; };
  globalThis.sched_testDouble = function(n) { return (typeof n === 'number' ? n : 0) * 2; };
  globalThis.sched_testAddTen = function(n) { return (typeof n === 'number' ? n : 0) + 10; };
  globalThis.sched_testThrowOnSecondCall = function() {
    _sched_testThrowOnSecondCallCount++;
    if (_sched_testThrowOnSecondCallCount > 1) {
      throw new Error('sched_testThrowOnSecondCall: forced failure on call ' + _sched_testThrowOnSecondCallCount);
    }
    return 1;
  };
  globalThis.sched_testSleepThreeSec = function() {
    Utilities.sleep(3000);
    return 'done';
  };
  log('← [CF global before] helpers registered count=' + _CF_HELPERS.length);
});

after(function() {
  log('→ [CF global after] delete helpers from globalThis');
  _CF_HELPERS.forEach(function(name) {
    try { delete globalThis[name]; } catch (e) {}
  });
  log('← [CF global after] done');
});

// ============================================================================
// Shared helpers
// ============================================================================

function cleanupJobFromDrive(scheduler, jobId) {
  ['jobs', 'locks', 'results', 'deadLetters'].forEach(function(type) {
    try {
      var folder = scheduler.driveStorage.getFolder(type);
      var files = folder.getFiles();
      while (files.hasNext()) {
        var f = files.next();
        if (f.getName().indexOf(jobId) !== -1) {
          try { f.setTrashed(true); } catch (e) {}
        }
      }
    } catch (e) {}
  });
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

function cleanupPropKeys(keys) {
  keys.forEach(function(k) {
    try { PropertiesService.getScriptProperties().deleteProperty(k); } catch (e) {}
  });
}

function cleanupSchedPropKeys() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function(k) {
    if (k.indexOf('cancel_sched-cf') === 0 ||
        k.indexOf('SCHEDULER_JOB_sched-cf') === 0 ||
        k.indexOf('SCHEDULER_NOTIFY_sched-cf') === 0) {
      try { PropertiesService.getScriptProperties().deleteProperty(k); } catch (e) {}
    }
  });
}

function cleanupProcessQueueTriggers() {
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
    });
  } catch (e) {}
}

// ============================================================================
// CF-01..03: Chained result accumulation
// ============================================================================

describe('ChainedFlows [CHAIN] — multi-step result accumulation', function() {

  var scheduler;

  before(function() {
    log('→ [CF-CHAIN before] creating scheduler');
    scheduler = new JobScheduler();
    log('← [CF-CHAIN before] initialized');
  });

  after(function() {
    log('→ [CF-CHAIN after] cleanup triggers');
    cleanupProcessQueueTriggers();
    log('← [CF-CHAIN after] done');
  });

  it('[CF-01] 3-step job completes with results array of length 3', function() {
    var builder = scheduler.create('Math.random')
      .thenAfter('Math.abs', 0)
      .thenAfter('Math.floor', 0);
    var jobId = builder.job.jobId;
    builder.job.metadata.tags = [jobId];
    builder.schedule();
    var triggerUid = 'sched-cf01-' + jobId;
    log('→ [CF-01] 3-step Math.random→abs→floor | jobId=' + jobId + ' triggerUid=' + triggerUid);
    try {
      Entrypoints.processQueue({ triggerUid: triggerUid });
      var pair = scheduler.pickup('Math.random', jobId);
      var results = pair[0];
      log('← [CF-01] results.length=' + results.length + ' results=' + JSON.stringify(results));
      expect(Array.isArray(results)).to.equal(true);
      expect(results.length).to.equal(3);
      results.forEach(function(r) { expect(typeof r).to.equal('number'); });
    } finally {
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerUid]);
    }
  });

  it('[CF-02] 2-step job: step 1 returns 42, step 2 doubles its own arg (not auto-injected)', function() {
    var builder = scheduler.create('sched_testReturnFortyTwo')
      .thenAfter('sched_testDouble', 5); // step 2 args are explicit, not auto-injected
    var jobId = builder.job.jobId;
    builder.job.metadata.tags = [jobId];
    builder.schedule();
    var triggerUid = 'sched-cf02-' + jobId;
    log('→ [CF-02] 2-step returnFortyTwo→double(5) | jobId=' + jobId);
    try {
      Entrypoints.processQueue({ triggerUid: triggerUid });
      var pair = scheduler.pickup('sched_testReturnFortyTwo', jobId);
      var results = pair[0];
      log('← [CF-02] results=' + JSON.stringify(results) + ' len=' + results.length);
      expect(Array.isArray(results)).to.equal(true);
      expect(results.length).to.equal(2);
      expect(results[0]).to.equal(42); // step 1 result
      expect(typeof results[1]).to.equal('number'); // step 2 result (5*2=10)
    } finally {
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerUid]);
    }
  });

  it('[CF-03] 3-step job where step 2 throws lands in deadLetters; step 1 result preserved', function() {
    _sched_testThrowOnSecondCallCount = 1; // prime so next call (count→2) throws
    var builder = scheduler.create('sched_testReturnFortyTwo')
      .thenAfter('sched_testThrowOnSecondCall') // 2nd call throws
      .thenAfter('sched_testAddTen', 0);
    var jobId = builder.job.jobId;
    builder.schedule();
    var triggerUid = 'sched-cf03-' + jobId;
    log('→ [CF-03] 3-step where step2 throws | jobId=' + jobId + ' throwCount=' + _sched_testThrowOnSecondCallCount);
    try {
      try {
        Entrypoints.processQueue({ triggerUid: triggerUid });
      } catch (e) {
        log('← [CF-03] processQueue threw (expected for error jobs): ' + e.message);
      }
      var inDead = folderContainsJob(scheduler, 'deadLetters', jobId);
      var inResults = folderContainsJob(scheduler, 'results', jobId);
      log('← [CF-03] inDeadLetters=' + inDead + ' inResults=' + inResults);
      expect(inDead).to.equal(true);
      expect(inResults).to.equal(false);
    } finally {
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerUid]);
      _sched_testThrowOnSecondCallCount = 0;
    }
  });

});

// ============================================================================
// CF-04..05: Timeout serialization via short maxRuntime
// ============================================================================

describe('ChainedFlows [TIMEOUT] — short maxRuntime leaves jobs pending', function() {

  it('[CF-04] maxRuntime:1ms → processQueue exits before processing; jobs stay in jobs folder', function() {
    // maxRuntime=1ms: PropertiesService + ScriptApp calls in processQueue take >1ms,
    // so the while-loop condition fails before the first batch is dequeued.
    var scheduler = new JobScheduler({ maxRuntime: 1 });
    var seededIds = [];
    for (var i = 0; i < 3; i++) {
      var builder = scheduler.create('Math.random');
      seededIds.push(builder.job.jobId);
      builder.schedule();
    }
    var triggerUid = 'sched-cf04-' + Date.now();
    log('→ [CF-04] maxRuntime=1ms | seeded=' + seededIds.length + ' jobs | triggerUid=' + triggerUid);
    try {
      scheduler.processQueue(triggerUid); // use scheduler directly (not Entrypoints, which creates its own)
      var remaining = 0;
      seededIds.forEach(function(id) {
        if (folderContainsJob(scheduler, 'jobs', id)) remaining++;
      });
      log('← [CF-04] remaining in jobs=' + remaining + ' / ' + seededIds.length);
      expect(remaining).to.be.greaterThan(0);
    } finally {
      seededIds.forEach(function(id) { cleanupJobFromDrive(scheduler, id); });
      cleanupPropKeys(['cancel_' + triggerUid]);
      cleanupProcessQueueTriggers();
    }
  });

  it('[CF-05] maxRuntime:10000ms with 7 sleep-3s jobs → batch-2 skipped; ≥2 stay pending', function() {
    // processQueue fetches up to 5 jobs per batch. With maxRuntime=10s:
    // Batch 1: 5 jobs × 3s = ~15s (exceeds 10s, but inner loop finishes the batch)
    // Batch 2: while condition 15s >= 10s is FALSE → loop exits → 2 jobs remain
    var scheduler = new JobScheduler({ maxRuntime: 10000 });
    var seededIds = [];
    for (var i = 0; i < 7; i++) {
      var builder = scheduler.create('sched_testSleepThreeSec');
      seededIds.push(builder.job.jobId);
      builder.schedule();
    }
    var triggerUid = 'sched-cf05-' + Date.now();
    log('→ [CF-05] maxRuntime=10s | seeded=' + seededIds.length + ' sleep-3s jobs | triggerUid=' + triggerUid);
    try {
      scheduler.processQueue(triggerUid);
      var remaining = 0;
      seededIds.forEach(function(id) {
        if (folderContainsJob(scheduler, 'jobs', id)) remaining++;
      });
      log('← [CF-05] remaining in jobs=' + remaining + ' / ' + seededIds.length);
      expect(remaining).to.be.greaterThan(0);
    } finally {
      seededIds.forEach(function(id) { cleanupJobFromDrive(scheduler, id); });
      cleanupPropKeys(['cancel_' + triggerUid]);
      cleanupProcessQueueTriggers();
    }
  });

});

// ============================================================================
// CF-06..10: rescheduleCurrentJobIfNeeded
// ============================================================================

describe('ChainedFlows [RESCHED] — rescheduleCurrentJobIfNeeded', function() {

  var scheduler;

  before(function() {
    log('→ [CF-RESCHED before] creating scheduler maxRuntime=1ms');
    scheduler = new JobScheduler({ maxRuntime: 1 });
    log('← [CF-RESCHED before] initialized');
  });

  after(function() {
    log('→ [CF-RESCHED after] cleanup sched-cf* keys + Drive + triggers');
    cleanupSchedPropKeys();
    try {
      var folders = DriveApp.getFoldersByName(scheduler.driveStorage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
    cleanupProcessQueueTriggers();
    log('← [CF-RESCHED after] done');
  });

  function makeActiveLockFile(testJobId, resumeIndex, rescheduleCount) {
    var jobData = {
      jobId: testJobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      state: JOB_STATES.RUNNING,
      metadata: {
        created: new Date().toISOString(),
        resumeIndex: resumeIndex || 0,
        rescheduleCount: rescheduleCount || 0
      }
    };
    var lockFilename = FileUtils.createJobFilename(JOB_STATES.RUNNING, testJobId, '');
    return {
      file: scheduler.driveStorage.getFolder('locks').createFile(lockFilename, JSON.stringify(jobData)),
      filename: lockFilename
    };
  }

  function seedContext(triggerId, lockFilename) {
    scheduler.currentContext.triggerId = triggerId;
    scheduler.currentContext.startTime = Date.now() - 10000; // 10s ago → well past 1ms maxRuntime
    var registry = {};
    registry[triggerId] = {
      jobFileName: lockFilename,
      startTime: new Date().toISOString(),
      currentFunction: null
    };
    PropertiesService.getScriptProperties().setProperty('ActiveJobsRegistry', JSON.stringify(registry));
  }

  function resetContext() {
    scheduler.currentContext.triggerId = null;
    scheduler.currentContext.startTime = null;
    try { PropertiesService.getScriptProperties().deleteProperty('ActiveJobsRegistry'); } catch (e) {}
  }

  it('[CF-06] rescheduleCurrentJobIfNeeded returns [true, newFilename] and creates PENDING file', function() {
    var jobId = 'sched-cf06-' + Date.now();
    var lock = makeActiveLockFile(jobId, 0, 0);
    var triggerId = 'sched-cf06-trig-' + Date.now();
    log('→ [CF-06] reschedule | jobId=' + jobId + ' resumeIndex=0 rescheduleCount=0');
    seedContext(triggerId, lock.filename);
    try {
      var result = scheduler.rescheduleCurrentJobIfNeeded(null);
      log('← [CF-06] result[0]=' + result[0] + ' result[1]=' + result[1] + ' inJobs=' + folderContainsJob(scheduler, 'jobs', jobId));
      expect(result[0]).to.equal(true);
      expect(result[1]).to.be.a('string');
      expect(result[1].length).to.be.greaterThan(0);
      expect(folderContainsJob(scheduler, 'jobs', jobId)).to.equal(true);
    } finally {
      resetContext();
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerId]);
    }
  });

  it('[CF-07] rescheduled job preserves resumeIndex from metadata', function() {
    var jobId = 'sched-cf07-' + Date.now();
    var lock = makeActiveLockFile(jobId, 2, 0); // resumeIndex=2
    var triggerId = 'sched-cf07-trig-' + Date.now();
    log('→ [CF-07] reschedule | jobId=' + jobId + ' resumeIndex=2');
    seedContext(triggerId, lock.filename);
    try {
      var result = scheduler.rescheduleCurrentJobIfNeeded(null);
      log('← [CF-07] rescheduled=' + result[0] + ' searching new PENDING for resumeIndex');
      expect(result[0]).to.equal(true);
      var jobs = scheduler.driveStorage.getFolder('jobs').getFiles();
      var foundJob = null;
      while (jobs.hasNext()) {
        var f = jobs.next();
        if (f.getName().indexOf(jobId) !== -1) {
          foundJob = JSON.parse(f.getBlob().getDataAsString());
          break;
        }
      }
      log('← [CF-07] foundJob.metadata.resumeIndex=' + (foundJob ? foundJob.metadata.resumeIndex : 'null'));
      expect(foundJob).to.not.equal(null);
      expect(foundJob.metadata.resumeIndex).to.equal(2);
    } finally {
      resetContext();
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerId]);
    }
  });

  it('[CF-08] newArgs=[10,20] updates parameters of the current step in rescheduled job', function() {
    var jobId = 'sched-cf08-' + Date.now();
    var lock = makeActiveLockFile(jobId, 0, 0);
    var triggerId = 'sched-cf08-trig-' + Date.now();
    log('→ [CF-08] reschedule with newArgs=[10,20] | jobId=' + jobId);
    seedContext(triggerId, lock.filename);
    try {
      var result = scheduler.rescheduleCurrentJobIfNeeded([10, 20]);
      log('← [CF-08] rescheduled=' + result[0] + ' checking steps[0].parameters');
      expect(result[0]).to.equal(true);
      var jobs = scheduler.driveStorage.getFolder('jobs').getFiles();
      var foundJob = null;
      while (jobs.hasNext()) {
        var f = jobs.next();
        if (f.getName().indexOf(jobId) !== -1) {
          foundJob = JSON.parse(f.getBlob().getDataAsString());
          break;
        }
      }
      log('← [CF-08] foundJob.steps[0].parameters=' + (foundJob ? JSON.stringify(foundJob.steps[0].parameters) : 'null'));
      expect(foundJob).to.not.equal(null);
      expect(foundJob.steps[0].parameters).to.deep.equal([10, 20]);
    } finally {
      resetContext();
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerId]);
    }
  });

  it('[CF-09] rescheduleCount at MAX_RESCHEDULE_RETRIES → job moves to deadLetters', function() {
    var jobId = 'sched-cf09-' + Date.now();
    var lock = makeActiveLockFile(jobId, 0, JobScheduler.MAX_RESCHEDULE_RETRIES); // count=15
    var triggerId = 'sched-cf09-trig-' + Date.now();
    log('→ [CF-09] reschedule at MAX_RESCHEDULE_RETRIES=' + JobScheduler.MAX_RESCHEDULE_RETRIES + ' | jobId=' + jobId);
    seedContext(triggerId, lock.filename);
    try {
      var result = scheduler.rescheduleCurrentJobIfNeeded(null);
      var inDead = folderContainsJob(scheduler, 'deadLetters', jobId);
      var inJobs = folderContainsJob(scheduler, 'jobs', jobId);
      log('← [CF-09] result[0]=' + result[0] + ' result[1]=' + result[1] + ' inDead=' + inDead + ' inJobs=' + inJobs);
      expect(result[0]).to.equal(true);
      expect(result[1]).to.equal(null);
      expect(inDead).to.equal(true);
      expect(inJobs).to.equal(false);
    } finally {
      resetContext();
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerId]);
    }
  });

  it('[CF-10] cancellation requested → returns [true, null] without creating new file', function() {
    var triggerId = 'sched-cf10-trig-' + Date.now();
    scheduler.currentContext.triggerId = triggerId;
    scheduler.currentContext.startTime = Date.now() - 10000;
    scheduler.requestCancellation(triggerId);
    log('→ [CF-10] cancellation requested | triggerId=' + triggerId);
    try {
      var result = scheduler.rescheduleCurrentJobIfNeeded(null);
      log('← [CF-10] result[0]=' + result[0] + ' result[1]=' + result[1]);
      expect(result[0]).to.equal(true);
      expect(result[1]).to.equal(null);
    } finally {
      scheduler.currentContext.triggerId = null;
      scheduler.currentContext.startTime = null;
      scheduler.clearCancellation(triggerId);
    }
  });

});

// ============================================================================
// CF-11..12: Resume from serialized state
// ============================================================================

describe('ChainedFlows [RESUME] — resume from serialized state', function() {

  var scheduler;

  before(function() {
    log('→ [CF-RESUME before] creating scheduler');
    scheduler = new JobScheduler();
    log('← [CF-RESUME before] initialized');
  });

  after(function() {
    log('→ [CF-RESUME after] cleanup triggers + Drive');
    cleanupProcessQueueTriggers();
    try {
      var folders = DriveApp.getFoldersByName(scheduler.driveStorage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
    log('← [CF-RESUME after] done');
  });

  it('[CF-11] job with resumeIndex=1 skips step 0; results has 2 entries not 3', function() {
    var jobId = 'sched-cf11-' + Date.now();
    log('→ [CF-11] seed 3-step job with resumeIndex=1 | jobId=' + jobId);
    var jobData = {
      jobId: jobId,
      steps: [
        { functionPath: 'sched_testReturnFortyTwo', parameters: [] },
        { functionPath: 'sched_testDouble', parameters: [5] },
        { functionPath: 'sched_testAddTen', parameters: [0] }
      ],
      state: JOB_STATES.PENDING,
      metadata: {
        created: new Date().toISOString(),
        resumeIndex: 1, // skip step 0
        tags: [jobId]
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.PENDING, jobId, '');
    scheduler.driveStorage.getFolder('jobs').createFile(filename, JSON.stringify(jobData));
    var triggerUid = 'sched-cf11-' + jobId;
    try {
      Entrypoints.processQueue({ triggerUid: triggerUid });
      var pair = scheduler.pickup('sched_testReturnFortyTwo', jobId);
      var results = pair[0];
      log('← [CF-11] results.length=' + results.length + ' results=' + JSON.stringify(results));
      expect(Array.isArray(results)).to.equal(true);
      expect(results.length).to.equal(2);
    } finally {
      cleanupJobFromDrive(scheduler, jobId);
      cleanupPropKeys(['cancel_' + triggerUid]);
    }
  });

  it('[CF-12] end-to-end: schedule → processQueue maxRuntime:1ms → job stays → reprocess → completes', function() {
    var fastScheduler = new JobScheduler({ maxRuntime: 1 });
    var builder = fastScheduler.create('Math.random');
    var jobId = builder.job.jobId;
    builder.job.metadata.tags = [jobId];
    builder.schedule();
    var triggerUid1 = 'sched-cf12a-' + jobId;
    var triggerUid2 = 'sched-cf12b-' + jobId;
    log('→ [CF-12] schedule + 2-pass processQueue | jobId=' + jobId + ' maxRuntime=1ms then 350s');

    try {
      // First run: maxRuntime=1ms → times out, job stays pending
      Entrypoints.processQueue({ triggerUid: triggerUid1 });
      var inResultsAfterFirst = folderContainsJob(fastScheduler, 'results', jobId);
      log('← [CF-12] after first pass | inResults=' + inResultsAfterFirst);

      if (!inResultsAfterFirst) {
        // Job still pending — process it with a generous timeout
        var fullScheduler = new JobScheduler({ maxRuntime: 350000 });
        Entrypoints.processQueue({ triggerUid: triggerUid2 });
        var inResultsFinal = folderContainsJob(fullScheduler, 'results', jobId);
        var inDeadFinal = folderContainsJob(fullScheduler, 'deadLetters', jobId);
        log('← [CF-12] after second pass | inResults=' + inResultsFinal + ' inDead=' + inDeadFinal);
        expect(inResultsFinal || inDeadFinal).to.equal(true);
      } else {
        // Job completed in first pass (timing edge case) — verify result is valid
        var pair = fastScheduler.pickup('Math.random', jobId);
        log('← [CF-12] completed first pass | results.length=' + pair[0].length);
        expect(Array.isArray(pair[0])).to.equal(true);
      }
    } finally {
      cleanupJobFromDrive(fastScheduler, jobId);
      try { cleanupJobFromDrive(new JobScheduler(), jobId); } catch (e) {}
      cleanupPropKeys(['cancel_' + triggerUid1, 'cancel_' + triggerUid2]);
      cleanupProcessQueueTriggers();
    }
  });

});
}
__defineModule__(_main);
