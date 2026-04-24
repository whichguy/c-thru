function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
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
// Helpers
// ============================================================================

function cleanupPropKeys(keys) {
  var props = PropertiesService.getScriptProperties();
  keys.forEach(function(k) {
    try { props.deleteProperty(k); } catch (e) {}
  });
}

function trashStorage(scheduler) {
  try {
    var folders = DriveApp.getFoldersByName(scheduler.driveStorage.rootFolderName);
    while (folders.hasNext()) { folders.next().setTrashed(true); }
  } catch (e) {}
}

// ============================================================================
// JS-01..04: requestCancellation / isCancellationRequested / clearCancellation
// ============================================================================

describe('JobScheduler [CANCEL] — cancellation API', function() {

  var scheduler;
  var testTrigger;

  before(function() {
    scheduler = new JobScheduler();
    testTrigger = 'sched-cancel-unit-' + Date.now();
    log('→ [JS-CANCEL before] testTrigger=' + testTrigger);
  });

  after(function() {
    cleanupPropKeys(['cancel_' + testTrigger]);
    log('← [JS-CANCEL after] cleaned cancel_' + testTrigger);
  });

  it('[JS-01] requestCancellation sets the cancel_* key in ScriptProperties', function() {
    log('→ [JS-01] requestCancellation | triggerId=' + testTrigger);
    scheduler.requestCancellation(testTrigger);
    var val = PropertiesService.getScriptProperties().getProperty('cancel_' + testTrigger);
    log('← [JS-01] cancel_key=' + val);
    expect(val).to.not.equal(null);
  });

  it('[JS-02] isCancellationRequested returns true after requestCancellation', function() {
    log('→ [JS-02] isCancellationRequested | triggerId=' + testTrigger);
    var result = scheduler.isCancellationRequested(testTrigger);
    log('← [JS-02] isCancellationRequested=' + result);
    expect(result).to.equal(true);
  });

  it('[JS-03] clearCancellation removes the cancel_* key', function() {
    log('→ [JS-03] clearCancellation | triggerId=' + testTrigger);
    scheduler.clearCancellation(testTrigger);
    var val = PropertiesService.getScriptProperties().getProperty('cancel_' + testTrigger);
    log('← [JS-03] cancel_key=' + val);
    expect(val).to.equal(null);
  });

  it('[JS-04] isCancellationRequested returns false for unknown triggerId', function() {
    log('→ [JS-04] isCancellationRequested("non-existent-trigger-xyz")');
    var result = scheduler.isCancellationRequested('non-existent-trigger-xyz');
    log('← [JS-04] isCancellationRequested=' + result);
    expect(result).to.equal(false);
  });

});

// ============================================================================
// JS-05..06: timeRemaining / isCloseToTimeout
// ============================================================================

describe('JobScheduler [TIMEOUT] — timeRemaining and isCloseToTimeout', function() {

  it('[JS-05] timeRemaining returns null when no active context', function() {
    log('→ [JS-05] timeRemaining | context=none');
    var scheduler = new JobScheduler();
    var result = scheduler.timeRemaining();
    log('← [JS-05] timeRemaining=' + result);
    expect(result).to.equal(null);
  });

  it('[JS-06] isCloseToTimeout returns false when no active context (null remaining)', function() {
    log('→ [JS-06] isCloseToTimeout | context=none');
    var scheduler = new JobScheduler();
    var result = scheduler.isCloseToTimeout();
    log('← [JS-06] isCloseToTimeout=' + result);
    expect(result).to.equal(false);
  });

});

// ============================================================================
// JS-07..10: registerActiveJob / unregisterActiveJob / updateActiveJobFunction
// ============================================================================

describe('JobScheduler [REGISTRY] — ActiveJobsRegistry management', function() {

  var scheduler;
  var triggerId;
  var keysToClean;

  before(function() {
    scheduler = new JobScheduler();
    triggerId = 'sched-reg-' + Date.now();
    keysToClean = ['ActiveJobsRegistry'];
    log('→ [JS-REGISTRY before] triggerId=' + triggerId);
  });

  after(function() {
    cleanupPropKeys(keysToClean);
    log('← [JS-REGISTRY after] cleaned ActiveJobsRegistry');
  });

  it('[JS-07] registerActiveJob stores job in ActiveJobsRegistry', function() {
    log('→ [JS-07] registerActiveJob | triggerId=' + triggerId + ' file=RUNNING-test123.json');
    scheduler.registerActiveJob(triggerId, 'RUNNING-test123.json');
    var registry = JSON.parse(
      PropertiesService.getScriptProperties().getProperty('ActiveJobsRegistry') || '{}'
    );
    log('← [JS-07] registry[triggerId].jobFileName=' + (registry[triggerId] ? registry[triggerId].jobFileName : 'missing'));
    expect(registry[triggerId]).to.not.equal(undefined);
    expect(registry[triggerId].jobFileName).to.equal('RUNNING-test123.json');
  });

  it('[JS-08] updateActiveJobFunction updates currentFunction in registry', function() {
    log('→ [JS-08] updateActiveJobFunction | triggerId=' + triggerId + ' fn=Math.random');
    scheduler.updateActiveJobFunction(triggerId, 'Math.random');
    var registry = JSON.parse(
      PropertiesService.getScriptProperties().getProperty('ActiveJobsRegistry') || '{}'
    );
    log('← [JS-08] currentFunction=' + (registry[triggerId] ? registry[triggerId].currentFunction : 'missing'));
    expect(registry[triggerId].currentFunction).to.equal('Math.random');
  });

  it('[JS-09] unregisterActiveJob removes the entry from registry', function() {
    log('→ [JS-09] unregisterActiveJob | triggerId=' + triggerId);
    scheduler.unregisterActiveJob(triggerId);
    var raw = PropertiesService.getScriptProperties().getProperty('ActiveJobsRegistry');
    log('← [JS-09] ActiveJobsRegistry=' + (raw === null ? 'null(deleted)' : 'present'));
    if (raw !== null) {
      var registry = JSON.parse(raw);
      expect(registry[triggerId]).to.equal(undefined);
    } else {
      // Key deleted when registry is empty — also correct
      expect(raw).to.equal(null);
    }
  });

  it('[JS-10] unregisterActiveJob on empty registry does not throw', function() {
    log('→ [JS-10] unregisterActiveJob("non-existent") → no throw');
    var threw = false;
    try {
      scheduler.unregisterActiveJob('non-existent-trigger-xyz');
    } catch (e) {
      threw = true;
    }
    log('← [JS-10] threw=' + threw);
    expect(threw).to.equal(false);
  });

});

// ============================================================================
// JS-11..14: checkJobReadiness (Drive)
// ============================================================================

describe('JobScheduler [READINESS] — checkJobReadiness', function() {

  var scheduler;

  before(function() {
    scheduler = new JobScheduler();
    log('→ [JS-READINESS before] root=' + scheduler.driveStorage.rootFolderName);
  });

  after(function() {
    log('→ [JS-READINESS after] cleanup root=' + scheduler.driveStorage.rootFolderName);
    try {
      var folders = DriveApp.getFoldersByName(scheduler.driveStorage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JS-11] job with no startEarliestTime → shouldProcess true', function() {
    var jobId = 'sched-ready-' + Date.now();
    log('→ [JS-11] checkJobReadiness | jobId=' + jobId + ' startEarliestTime=none');
    var jobData = {
      jobId: jobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      metadata: { created: new Date().toISOString() }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.PENDING, jobId, '');
    var file = scheduler.driveStorage.getFolder('jobs').createFile(filename, JSON.stringify(jobData));
    try {
      var result = scheduler.checkJobReadiness(file);
      log('← [JS-11] shouldProcess=' + result.shouldProcess);
      expect(result.shouldProcess).to.equal(true);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

  it('[JS-12] job with past startEarliestTime → shouldProcess true', function() {
    var jobId = 'sched-past-' + Date.now();
    var pastTime = new Date(Date.now() - 60000).toISOString();
    log('→ [JS-12] checkJobReadiness | jobId=' + jobId + ' startEarliestTime=-1min');
    var jobData = {
      jobId: jobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      metadata: {
        created: new Date().toISOString(),
        startEarliestTime: pastTime
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.PENDING, jobId, '');
    var file = scheduler.driveStorage.getFolder('jobs').createFile(filename, JSON.stringify(jobData));
    try {
      var result = scheduler.checkJobReadiness(file);
      log('← [JS-12] shouldProcess=' + result.shouldProcess);
      expect(result.shouldProcess).to.equal(true);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

  it('[JS-13] job with 1-hour future startEarliestTime → shouldProcess false', function() {
    var jobId = 'sched-future-' + Date.now();
    var futureTime = new Date(Date.now() + 3600000).toISOString();
    log('→ [JS-13] checkJobReadiness | jobId=' + jobId + ' startEarliestTime=+1h');
    var jobData = {
      jobId: jobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      metadata: {
        created: new Date().toISOString(),
        startEarliestTime: futureTime
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.PENDING, jobId, '');
    var file = scheduler.driveStorage.getFolder('jobs').createFile(filename, JSON.stringify(jobData));
    try {
      var result = scheduler.checkJobReadiness(file);
      log('← [JS-13] shouldProcess=' + result.shouldProcess);
      expect(result.shouldProcess).to.equal(false);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

  it('[JS-14] corrupt JSON file → shouldProcess false (error handled gracefully)', function() {
    var filename = 'PENDING-corrupt-test-' + Date.now() + '.json';
    log('→ [JS-14] checkJobReadiness | file=corrupt-json');
    var file = scheduler.driveStorage.getFolder('jobs').createFile(filename, 'not-valid-json');
    try {
      var result = scheduler.checkJobReadiness(file);
      log('← [JS-14] shouldProcess=' + result.shouldProcess);
      expect(result.shouldProcess).to.equal(false);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

});

// ============================================================================
// JS-15..18: handleRepeat
// ============================================================================

describe('JobScheduler [REPEAT] — handleRepeat behavior', function() {

  var scheduler;

  before(function() {
    scheduler = new JobScheduler();
    log('→ [JS-REPEAT before] root=' + scheduler.driveStorage.rootFolderName);
  });

  after(function() {
    log('→ [JS-REPEAT after] cleanup root=' + scheduler.driveStorage.rootFolderName);
    try {
      var folders = DriveApp.getFoldersByName(scheduler.driveStorage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JS-15] handleRepeat no-ops when job has no repeat metadata', function() {
    log('→ [JS-15] handleRepeat(no repeat metadata) → no-op');
    var threw = false;
    try {
      scheduler.handleRepeat({ metadata: {}, steps: [] });
    } catch (e) { threw = true; }
    log('← [JS-15] threw=' + threw);
    expect(threw).to.equal(false);
  });

  it('[JS-16] handleRepeat no-ops when count mode has reached its limit', function() {
    log('→ [JS-16] handleRepeat | mode=count count=3 repeatCount=3 → at limit, no-op');
    var threw = false;
    try {
      scheduler.handleRepeat({
        steps: [{ functionPath: 'Math.random', parameters: [] }],
        metadata: {
          repeat: { mode: 'count', count: 3, intervalMs: 0 },
          repeatCount: 3 // already at limit
        }
      });
    } catch (e) { threw = true; }
    log('← [JS-16] threw=' + threw);
    expect(threw).to.equal(false);
  });

  it('[JS-17] handleRepeat with mode=count below limit creates a new PENDING job', function() {
    var jobId = 'sched-rep-count-' + Date.now();
    log('→ [JS-17] handleRepeat | mode=count count=3 repeatCount=1 → creates PENDING | jobId=' + jobId);
    scheduler.handleRepeat({
      jobId: jobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      metadata: {
        created: new Date().toISOString(),
        repeat: { mode: 'count', count: 3, intervalMs: 0 },
        repeatCount: 1 // below limit of 3
      }
    });
    // Verify a new job was created in jobs folder
    var files = scheduler.driveStorage.getFolder('jobs').getFiles();
    var count = 0;
    while (files.hasNext()) { files.next(); count++; }
    log('← [JS-17] jobsCount=' + count);
    expect(count).to.be.greaterThan(0);
    // Cleanup
    files = scheduler.driveStorage.getFolder('jobs').getFiles();
    while (files.hasNext()) { try { files.next().setTrashed(true); } catch (e) {} }
  });

  it('[JS-18] handleRepeat with mode=infinite always creates a new PENDING job', function() {
    var jobId = 'sched-rep-inf-' + Date.now();
    log('→ [JS-18] handleRepeat | mode=infinite repeatCount=999 → always creates PENDING | jobId=' + jobId);
    scheduler.handleRepeat({
      jobId: jobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      metadata: {
        created: new Date().toISOString(),
        repeat: { mode: 'infinite', count: 1, intervalMs: 0 },
        repeatCount: 999 // very high but mode=infinite always repeats
      }
    });
    var files = scheduler.driveStorage.getFolder('jobs').getFiles();
    var count = 0;
    while (files.hasNext()) { files.next(); count++; }
    log('← [JS-18] jobsCount=' + count);
    expect(count).to.be.greaterThan(0);
    // Cleanup
    files = scheduler.driveStorage.getFolder('jobs').getFiles();
    while (files.hasNext()) { try { files.next().setTrashed(true); } catch (e) {} }
  });

});

// ============================================================================
// JS-19..20: handleDelayedJob (pure data manipulation)
// ============================================================================

describe('JobScheduler [DELAYED] — handleDelayedJob data mutation', function() {

  var scheduler;

  before(function() {
    scheduler = new JobScheduler();
    log('→ [JS-DELAYED before] scheduler created');
  });

  it('[JS-19] handleDelayedJob sets delayedUntil from startEarliestTime', function() {
    var futureTime = new Date(Date.now() + 3600000).toISOString();
    var jobContent = {
      metadata: { startEarliestTime: futureTime }
    };
    var mockFile = { getName: function() { return 'PENDING-testjob.json'; } };
    log('→ [JS-19] handleDelayedJob | startEarliestTime=+1h file=' + mockFile.getName());
    scheduler.handleDelayedJob(mockFile, jobContent);
    log('← [JS-19] delayedUntil=' + jobContent.metadata.delayedUntil);
    expect(jobContent.metadata.delayedUntil).to.equal(futureTime);
  });

  it('[JS-20] handleDelayedJob sets lastDelayCheck to a recent ISO timestamp', function() {
    var before = Date.now();
    var jobContent = {
      metadata: { startEarliestTime: new Date(before + 3600000).toISOString() }
    };
    var mockFile = { getName: function() { return 'PENDING-testjob.json'; } };
    log('→ [JS-20] handleDelayedJob | before=' + before + ' file=' + mockFile.getName());
    scheduler.handleDelayedJob(mockFile, jobContent);
    var checkTime = new Date(jobContent.metadata.lastDelayCheck).getTime();
    log('← [JS-20] lastDelayCheck=' + jobContent.metadata.lastDelayCheck + ' checkTime>=' + before + ': ' + (checkTime >= before));
    expect(typeof jobContent.metadata.lastDelayCheck).to.equal('string');
    expect(checkTime).to.be.least(before);
  });

});
}
__defineModule__(_main);
