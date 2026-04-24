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
// Helpers
// ============================================================================

function seedJobKey(jobId, meta) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SCHEDULER_JOB_' + jobId, JSON.stringify(meta || { description: 'test job ' + jobId }));
}

function cleanJobKeys(jobId) {
  var props = PropertiesService.getScriptProperties();
  try { props.deleteProperty('SCHEDULER_JOB_' + jobId); } catch (e) {}
  try { props.deleteProperty('SCHEDULER_NOTIFY_' + jobId); } catch (e) {}
}

function trashStorage(scheduler) {
  try {
    var folders = DriveApp.getFoldersByName(scheduler.driveStorage.rootFolderName);
    while (folders.hasNext()) { folders.next().setTrashed(true); }
  } catch (e) {}
}

function ensureNoJobKeys() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function(k) {
    if (k.indexOf('SCHEDULER_JOB_') === 0 || k.indexOf('SCHEDULER_NOTIFY_') === 0) {
      PropertiesService.getScriptProperties().deleteProperty(k);
    }
  });
}

// ============================================================================
// NTF-01: Fast path — no SCHEDULER_JOB_* keys → returns [] immediately
// ============================================================================

describe('Notifications [FAST] — fast path when no tracked jobs', function() {

  before(function() {
    log('→ [NTF-FAST before] clearing all SCHEDULER_JOB_* keys');
    ensureNoJobKeys();
    log('← [NTF-FAST before] keys cleared');
  });

  it('[NTF-01] returns [] immediately with no SCHEDULER_JOB_* keys', function() {
    log('→ [NTF-01] getCompletedJobNotifications() with no keys');
    var result = Entrypoints.getCompletedJobNotifications();
    log('← [NTF-01] result.length=' + result.length);
    expect(Array.isArray(result)).to.equal(true);
    expect(result.length).to.equal(0);
  });

});

// ============================================================================
// NTF-02..04: Already-shown guard and first/second call behavior
// ============================================================================

describe('Notifications [SHOWN] — already-shown guard', function() {

  var jobId;
  var scheduler;
  var resultFile;

  before(function() {
    ensureNoJobKeys();
    jobId = 'ntf-shown-' + Date.now();
    scheduler = new JobScheduler();
    log('→ [NTF-SHOWN before] jobId=' + jobId);
    log('← [NTF-SHOWN before] scheduler initialized');
  });

  after(function() {
    log('→ [NTF-SHOWN after] cleanup jobId=' + jobId);
    cleanJobKeys(jobId);
    if (resultFile) { try { resultFile.setTrashed(true); } catch (e) {} }
    trashStorage(scheduler);
    log('← [NTF-SHOWN after] done');
  });

  it('[NTF-02] SCHEDULER_NOTIFY_{id}="shown" causes job to be excluded from results', function() {
    log('→ [NTF-02] seed jobKey + NOTIFY=shown | jobId=' + jobId);
    seedJobKey(jobId, { description: 'shown-job' });
    PropertiesService.getScriptProperties().setProperty('SCHEDULER_NOTIFY_' + jobId, 'shown');
    var result = Entrypoints.getCompletedJobNotifications();
    var found = result.some(function(n) { return n.jobId === jobId; });
    log('← [NTF-02] found=' + found + ' resultCount=' + result.length);
    expect(found).to.equal(false);
  });

  it('[NTF-03] first call with a result file returns the notification and sets shown flag', function() {
    var jobId2 = 'ntf-first-' + Date.now();
    log('→ [NTF-03] seed jobKey + SUCCESS file | jobId=' + jobId2);
    seedJobKey(jobId2, { description: 'first-call-job' });
    var content = {
      results: [1],
      state: JOB_STATES.SUCCESS,
      metadata: {
        originalJob: {
          jobId: jobId2,
          steps: [{ functionPath: 'Math.random', parameters: [] }],
          metadata: { tags: [] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.SUCCESS, jobId2, '');
    resultFile = scheduler.driveStorage.getFolder('results').createFile(filename, JSON.stringify(content));
    log('← [NTF-03] file=' + filename);

    var result = Entrypoints.getCompletedJobNotifications();
    var found = result.some(function(n) { return n.jobId === jobId2; });
    log('← [NTF-03] found=' + found + ' resultCount=' + result.length);
    expect(found).to.equal(true);

    var notifyVal = PropertiesService.getScriptProperties().getProperty('SCHEDULER_NOTIFY_' + jobId2);
    log('← [NTF-03] NOTIFY_flag=' + notifyVal);
    expect(notifyVal).to.equal('shown');

    cleanJobKeys(jobId2);
    try { resultFile.setTrashed(true); resultFile = null; } catch (e) {}
  });

  it('[NTF-04] second call for same job returns [] (already shown)', function() {
    var jobId3 = 'ntf-second-' + Date.now();
    log('→ [NTF-04] seed jobKey + NOTIFY=shown (pre-set) | jobId=' + jobId3);
    seedJobKey(jobId3, { description: 'second-call-job' });
    PropertiesService.getScriptProperties().setProperty('SCHEDULER_NOTIFY_' + jobId3, 'shown');

    var result = Entrypoints.getCompletedJobNotifications();
    var found = result.some(function(n) { return n.jobId === jobId3; });
    log('← [NTF-04] found=' + found + ' (expected false)');
    expect(found).to.equal(false);

    cleanJobKeys(jobId3);
  });

});

// ============================================================================
// NTF-05..06: SUCCESS / FAILED file detection
// ============================================================================

describe('Notifications [STATUS] — completion status detection', function() {

  var scheduler;
  var resultFile;
  var deadFile;

  before(function() {
    log('→ [NTF-STATUS before] clearing keys + creating scheduler');
    ensureNoJobKeys();
    scheduler = new JobScheduler();
    log('← [NTF-STATUS before] initialized');
  });

  after(function() {
    log('→ [NTF-STATUS after] cleanup files + storage');
    if (resultFile) { try { resultFile.setTrashed(true); } catch (e) {} }
    if (deadFile) { try { deadFile.setTrashed(true); } catch (e) {} }
    trashStorage(scheduler);
    log('← [NTF-STATUS after] done');
  });

  it('[NTF-05] SUCCESS file in results folder → notification.status === "completed"', function() {
    var jobId = 'ntf-success-' + Date.now();
    log('→ [NTF-05] seed SUCCESS file | jobId=' + jobId);
    seedJobKey(jobId, { description: 'success-job' });
    var content = {
      results: [42],
      state: JOB_STATES.SUCCESS,
      metadata: {
        originalJob: {
          jobId: jobId,
          steps: [{ functionPath: 'Math.random', parameters: [] }],
          metadata: { tags: [] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.SUCCESS, jobId, '');
    resultFile = scheduler.driveStorage.getFolder('results').createFile(filename, JSON.stringify(content));

    var notifications = Entrypoints.getCompletedJobNotifications();
    var notif = null;
    notifications.forEach(function(n) { if (n.jobId === jobId) notif = n; });
    log('← [NTF-05] notif=' + (notif ? JSON.stringify({ status: notif.status }) : 'null'));
    expect(notif).to.not.equal(null);
    expect(notif.status).to.equal('completed');

    cleanJobKeys(jobId);
    try { resultFile.setTrashed(true); resultFile = null; } catch (e) {}
  });

  it('[NTF-06] FAILED file in deadLetters folder → notification.status === "failed" with error field', function() {
    var jobId = 'ntf-fail-' + Date.now();
    log('→ [NTF-06] seed FAILED file | jobId=' + jobId);
    seedJobKey(jobId, { description: 'fail-job' });
    var content = {
      error: { message: 'test error msg', stepIndex: 0 },
      state: JOB_STATES.FAILED,
      metadata: {
        originalJob: {
          jobId: jobId,
          steps: [{ functionPath: 'Math.random', parameters: [] }],
          metadata: { tags: [] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.FAILED, jobId, '');
    deadFile = scheduler.driveStorage.getFolder('deadLetters').createFile(filename, JSON.stringify(content));

    var notifications = Entrypoints.getCompletedJobNotifications();
    var notif = null;
    notifications.forEach(function(n) { if (n.jobId === jobId) notif = n; });
    log('← [NTF-06] notif=' + (notif ? JSON.stringify({ status: notif.status, hasError: !!notif.error }) : 'null'));
    expect(notif).to.not.equal(null);
    expect(notif.status).to.equal('failed');
    expect(notif.error).to.not.equal(undefined);

    cleanJobKeys(jobId);
    try { deadFile.setTrashed(true); deadFile = null; } catch (e) {}
  });

});

// ============================================================================
// NTF-07: Job still pending (in jobs folder) → no notification
// ============================================================================

describe('Notifications [PENDING] — pending job produces no notification', function() {

  var scheduler;
  var pendingFile;

  before(function() {
    log('→ [NTF-PENDING before] clearing keys + creating scheduler');
    ensureNoJobKeys();
    scheduler = new JobScheduler();
    log('← [NTF-PENDING before] initialized');
  });

  after(function() {
    log('→ [NTF-PENDING after] cleanup');
    if (pendingFile) { try { pendingFile.setTrashed(true); } catch (e) {} }
    trashStorage(scheduler);
    log('← [NTF-PENDING after] done');
  });

  it('[NTF-07] job still in jobs folder (pending) → [] (not in results or deadLetters)', function() {
    var jobId = 'ntf-pending-' + Date.now();
    log('→ [NTF-07] seed PENDING file in jobs | jobId=' + jobId);
    seedJobKey(jobId, { description: 'pending-job' });
    var jobData = {
      jobId: jobId,
      steps: [{ functionPath: 'Math.random', parameters: [] }],
      state: JOB_STATES.PENDING,
      metadata: { created: new Date().toISOString() }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.PENDING, jobId, '');
    pendingFile = scheduler.driveStorage.getFolder('jobs').createFile(filename, JSON.stringify(jobData));

    var notifications = Entrypoints.getCompletedJobNotifications();
    var found = notifications.some(function(n) { return n.jobId === jobId; });
    log('← [NTF-07] found=' + found + ' (expected false) total=' + notifications.length);
    expect(found).to.equal(false);

    cleanJobKeys(jobId);
  });

});

// ============================================================================
// NTF-08: Notification shape verification
// ============================================================================

describe('Notifications [SHAPE] — notification object shape', function() {

  var scheduler;
  var resultFile;

  before(function() {
    log('→ [NTF-SHAPE before] clearing keys + creating scheduler');
    ensureNoJobKeys();
    scheduler = new JobScheduler();
    log('← [NTF-SHAPE before] initialized');
  });

  after(function() {
    log('→ [NTF-SHAPE after] cleanup');
    if (resultFile) { try { resultFile.setTrashed(true); } catch (e) {} }
    trashStorage(scheduler);
    log('← [NTF-SHAPE after] done');
  });

  it('[NTF-08] notification includes jobId, description, and status fields', function() {
    var jobId = 'ntf-shape-' + Date.now();
    var desc = 'shape-test-desc';
    log('→ [NTF-08] seed SUCCESS + jobKey | jobId=' + jobId + ' desc=' + desc);
    seedJobKey(jobId, { description: desc });

    var content = {
      results: [1],
      state: JOB_STATES.SUCCESS,
      metadata: {
        originalJob: {
          jobId: jobId,
          steps: [{ functionPath: 'Math.random', parameters: [] }],
          metadata: { tags: [] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.SUCCESS, jobId, '');
    resultFile = scheduler.driveStorage.getFolder('results').createFile(filename, JSON.stringify(content));

    var notifications = Entrypoints.getCompletedJobNotifications();
    var notif = null;
    notifications.forEach(function(n) { if (n.jobId === jobId) notif = n; });
    log('← [NTF-08] notif=' + (notif ? JSON.stringify({ jobId: notif.jobId, description: notif.description, status: notif.status }) : 'null'));

    expect(notif).to.not.equal(null);
    expect(notif).to.have.property('jobId');
    expect(notif).to.have.property('description');
    expect(notif).to.have.property('status');
    expect(notif.jobId).to.equal(jobId);
    expect(notif.description).to.equal(desc);
    expect(notif.status).to.equal('completed');

    cleanJobKeys(jobId);
    try { resultFile.setTrashed(true); resultFile = null; } catch (e) {}
  });

});
}
__defineModule__(_main);
