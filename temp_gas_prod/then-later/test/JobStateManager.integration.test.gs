function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var DriveStorageModule = require('then-later/storage/DriveStorage');
var JobStateManagerModule = require('then-later/storage/JobStateManager');

var describe = mocha.describe;
var it = mocha.it;
var before = mocha.beforeAll;
var after = mocha.afterAll;
var expect = chai.expect;

var DriveStorage = DriveStorageModule.DriveStorage;
var JobStateManager = JobStateManagerModule.JobStateManager;
var JOB_STATES = JobStateManagerModule.JOB_STATES;
var FileUtils = JobStateManagerModule.FileUtils;

var log = function(msg) { Logger.log(msg); };

// ============================================================================
// Helpers
// ============================================================================

function makeStorage(suffix) {
  var storage = new DriveStorage({ rootFolderName: 'ScheduledScripts-jsm-' + suffix });
  storage.initialize();
  return storage;
}

function createPendingFile(storage, jobId, description) {
  var filename = FileUtils.createJobFilename(JOB_STATES.PENDING, jobId, description || '');
  var jobData = {
    jobId: jobId,
    steps: [{ functionPath: 'Math.random', parameters: [] }],
    state: JOB_STATES.PENDING,
    metadata: { created: new Date().toISOString(), description: description || '' }
  };
  return storage.getFolder('jobs').createFile(filename, JSON.stringify(jobData));
}

function createLockFile(storage, jobId) {
  var filename = FileUtils.createJobFilename(JOB_STATES.RUNNING, jobId, '');
  var jobData = {
    jobId: jobId,
    steps: [{ functionPath: 'Math.random', parameters: [] }],
    state: JOB_STATES.RUNNING,
    metadata: { created: new Date().toISOString() }
  };
  return storage.getFolder('locks').createFile(filename, JSON.stringify(jobData));
}

// ============================================================================
// JSM-01..03: getJobContent cache
// ============================================================================

describe('JobStateManager [CACHE] — getJobContent cache hit/miss', function() {

  var rootName;
  var storage;
  var manager;
  var testFile;
  var testJobId;

  before(function() {
    rootName = 'ScheduledScripts-jsm-cache-' + Date.now();
    storage = makeStorage('cache-' + Date.now());
    manager = new JobStateManager({ driveStorage: storage });
    testJobId = 'jsm-cache-' + Date.now();
    log('→ [JSM-CACHE before] jobId=' + testJobId + ' root=' + storage.rootFolderName);
    testFile = createPendingFile(storage, testJobId, '');
    log('← [JSM-CACHE before] file=' + testFile.getName());
  });

  after(function() {
    log('→ [JSM-CACHE after] trash jobId=' + testJobId);
    try { if (testFile && !testFile.isTrashed()) testFile.setTrashed(true); } catch (e) {}
    try {
      var folders = DriveApp.getFoldersByName(storage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JSM-01] getJobContent returns parsed job object on cache miss', function() {
    log('→ [JSM-01] getJobContent(file) cache miss | file=' + testFile.getName());
    var content = manager.getJobContent(testFile);
    log('← [JSM-01] jobId=' + content.jobId + ' state=' + content.state);
    expect(content).to.be.an('object');
    expect(content.jobId).to.equal(testJobId);
  });

  it('[JSM-02] getJobContent returns same data on cache hit (second call)', function() {
    log('→ [JSM-02] getJobContent(file) × 2 → cache hit');
    manager.getJobContent(testFile); // prime the cache
    var cached = manager.getJobContent(testFile);
    log('← [JSM-02] jobId=' + cached.jobId + ' cacheSize=' + manager.getCacheStats().jobContentCacheSize);
    expect(cached.jobId).to.equal(testJobId);
  });

  it('[JSM-03] clearCache() resets the cache size to 0', function() {
    manager.getJobContent(testFile);
    var sizeBefore = manager.getCacheStats().jobContentCacheSize;
    log('→ [JSM-03] clearCache() | sizeBefore=' + sizeBefore);
    manager.clearCache();
    var sizeAfter = manager.getCacheStats().jobContentCacheSize;
    log('← [JSM-03] sizeAfter=' + sizeAfter);
    expect(sizeBefore).to.be.greaterThan(0);
    expect(sizeAfter).to.equal(0);
  });

});

// ============================================================================
// JSM-04..06: transitionJobState
// ============================================================================

describe('JobStateManager [TRANSITION] — transitionJobState', function() {

  var storage;
  var manager;
  var jobId;
  var pendingFile;
  var resultFile;

  before(function() {
    storage = makeStorage('trans-' + Date.now());
    manager = new JobStateManager({ driveStorage: storage });
    jobId = 'jsm-trans-' + Date.now();
    log('→ [JSM-TRANS before] jobId=' + jobId + ' root=' + storage.rootFolderName);
    pendingFile = createPendingFile(storage, jobId, '');
    log('← [JSM-TRANS before] pendingFile=' + pendingFile.getName());
  });

  after(function() {
    log('→ [JSM-TRANS after] cleanup jobId=' + jobId);
    try { if (resultFile && !resultFile.isTrashed()) resultFile.setTrashed(true); } catch (e) {}
    try {
      var folders = DriveApp.getFoldersByName(storage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JSM-04] transitionJobState creates a new file in the destination folder', function() {
    log('→ [JSM-04] transition PENDING→RUNNING | jobId=' + jobId);
    resultFile = manager.transitionJobState(pendingFile, 'locks', JOB_STATES.RUNNING);
    log('← [JSM-04] file=' + resultFile.getName());
    expect(resultFile).to.not.equal(null);
    var lockFiles = storage.getFolder('locks').getFiles();
    var found = false;
    while (lockFiles.hasNext()) {
      if (lockFiles.next().getName().indexOf(jobId) !== -1) { found = true; break; }
    }
    expect(found).to.equal(true);
  });

  it('[JSM-05] original file is trashed after transition', function() {
    log('→ [JSM-05] pendingFile.isTrashed() | file=' + pendingFile.getName());
    var trashed = pendingFile.isTrashed();
    log('← [JSM-05] isTrashed=' + trashed);
    expect(trashed).to.equal(true);
  });

  it('[JSM-06] modifyFn is applied to the job data before creating new file', function() {
    var jobId2 = 'jsm-trans-mod-' + Date.now();
    log('→ [JSM-06] transition with modifyFn | jobId=' + jobId2);
    var file2 = createPendingFile(storage, jobId2, '');
    var modifiedFile = manager.transitionJobState(
      file2, 'results', JOB_STATES.SUCCESS,
      function(data) { data.metadata.testMarker = 'applied'; }
    );
    var content = JSON.parse(modifiedFile.getBlob().getDataAsString());
    log('← [JSM-06] testMarker=' + content.metadata.testMarker + ' file=' + modifiedFile.getName());
    expect(content.metadata.testMarker).to.equal('applied');
    try { modifiedFile.setTrashed(true); } catch (e) {}
  });

});

// ============================================================================
// JSM-07..11: acquireLock / releaseLock
// ============================================================================

describe('JobStateManager [LOCK] — acquireLock and releaseLock', function() {

  var storage;
  var manager;
  var jobId;
  var pendingFile;
  var lockFile;

  before(function() {
    storage = makeStorage('lock-' + Date.now());
    manager = new JobStateManager({ driveStorage: storage });
    jobId = 'jsm-lock-' + Date.now();
    log('→ [JSM-LOCK before] jobId=' + jobId + ' root=' + storage.rootFolderName);
    pendingFile = createPendingFile(storage, jobId, '');
    log('← [JSM-LOCK before] pendingFile=' + pendingFile.getName());
  });

  after(function() {
    log('→ [JSM-LOCK after] cleanup root=' + storage.rootFolderName);
    try {
      var folders = DriveApp.getFoldersByName(storage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JSM-07] acquireLock moves job file from jobs → locks as RUNNING', function() {
    log('→ [JSM-07] acquireLock | pendingFile=' + pendingFile.getName());
    lockFile = manager.acquireLock(pendingFile, 'test-trigger-lock');
    log('← [JSM-07] lockFile=' + (lockFile ? lockFile.getName() : 'null'));
    expect(lockFile).to.not.equal(null);
    expect(lockFile.getName().indexOf('RUNNING')).to.be.greaterThan(-1);
  });

  it('[JSM-08] releaseLock with SUCCESS routes file to results folder', function() {
    log('→ [JSM-08] releaseLock SUCCESS | lockFile=' + lockFile.getName());
    var successFile = manager.releaseLock(lockFile, JOB_STATES.SUCCESS, { results: [42] });
    log('← [JSM-08] successFile=' + (successFile ? successFile.getName() : 'null'));
    expect(successFile).to.not.equal(null);
    var files = storage.getFolder('results').getFiles();
    var found = false;
    while (files.hasNext()) {
      if (files.next().getName().indexOf(jobId) !== -1) { found = true; break; }
    }
    expect(found).to.equal(true);
    try { if (successFile && !successFile.isTrashed()) successFile.setTrashed(true); } catch (e) {}
  });

  it('[JSM-09] releaseLock with FAILED routes file to deadLetters folder', function() {
    var jobId2 = 'jsm-lock-fail-' + Date.now();
    log('→ [JSM-09] acquireLock + releaseLock FAILED | jobId=' + jobId2);
    var pending2 = createPendingFile(storage, jobId2, '');
    var lock2 = manager.acquireLock(pending2, 'test-trigger-fail');
    expect(lock2).to.not.equal(null);
    var failFile = manager.releaseLock(lock2, JOB_STATES.FAILED, { message: 'test error' });
    log('← [JSM-09] failFile=' + (failFile ? failFile.getName() : 'null'));
    var files = storage.getFolder('deadLetters').getFiles();
    var found = false;
    while (files.hasNext()) {
      if (files.next().getName().indexOf(jobId2) !== -1) { found = true; break; }
    }
    expect(found).to.equal(true);
    try { if (failFile && !failFile.isTrashed()) failFile.setTrashed(true); } catch (e) {}
  });

  it('[JSM-10] releaseLock with PENDING routes file back to jobs folder', function() {
    var jobId3 = 'jsm-lock-pend-' + Date.now();
    log('→ [JSM-10] acquireLock + releaseLock PENDING | jobId=' + jobId3);
    var pending3 = createPendingFile(storage, jobId3, '');
    var lock3 = manager.acquireLock(pending3, 'test-trigger-pend');
    expect(lock3).to.not.equal(null);
    var requeued = manager.releaseLock(lock3, JOB_STATES.PENDING, null);
    log('← [JSM-10] requeued=' + (requeued ? requeued.getName() : 'null'));
    var files = storage.getFolder('jobs').getFiles();
    var found = false;
    while (files.hasNext()) {
      if (files.next().getName().indexOf(jobId3) !== -1) { found = true; break; }
    }
    expect(found).to.equal(true);
    try { if (requeued && !requeued.isTrashed()) requeued.setTrashed(true); } catch (e) {}
  });

  it('[JSM-11] releaseLock with unknown destination defaults to jobs folder', function() {
    var jobId4 = 'jsm-lock-unk-' + Date.now();
    log('→ [JSM-11] acquireLock + releaseLock UNKNOWN_STATE | jobId=' + jobId4);
    var pending4 = createPendingFile(storage, jobId4, '');
    var lock4 = manager.acquireLock(pending4, 'test-trigger-unk');
    expect(lock4).to.not.equal(null);
    var routed = manager.releaseLock(lock4, 'UNKNOWN_STATE', null);
    log('← [JSM-11] routed=' + (routed ? routed.getName() : 'null'));
    // folderMap defaults unmapped states to 'jobs'
    expect(routed).to.not.equal(null);
    try { if (routed && !routed.isTrashed()) routed.setTrashed(true); } catch (e) {}
  });

});

// ============================================================================
// JSM-12..14: isLocked regression — compare by jobId, not full filename
// ============================================================================

describe('JobStateManager [ISLOCKED] — isLocked regression (jobId comparison)', function() {

  var storage;
  var manager;

  before(function() {
    storage = makeStorage('islocked-' + Date.now());
    manager = new JobStateManager({ driveStorage: storage });
    log('→ [JSM-ISLOCKED before] root=' + storage.rootFolderName);
  });

  after(function() {
    log('→ [JSM-ISLOCKED after] cleanup root=' + storage.rootFolderName);
    try {
      var folders = DriveApp.getFoldersByName(storage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JSM-12] isLocked returns false when no lock file exists for the job', function() {
    var jobId = 'jsmislnone' + Date.now();
    log('→ [JSM-12] isLocked | jobId=' + jobId + ' locks=empty');
    var pendingFile = createPendingFile(storage, jobId, '');
    try {
      var result = manager.isLocked(pendingFile);
      log('← [JSM-12] isLocked=' + result);
      expect(result).to.equal(false);
    } finally {
      try { pendingFile.setTrashed(true); } catch (e) {}
    }
  });

  it('[JSM-13] isLocked returns true when RUNNING-{sameJobId}.json exists in locks', function() {
    var jobId = 'jsmisl13match' + Date.now();
    log('→ [JSM-13] isLocked | jobId=' + jobId + ' lockFile=RUNNING-' + jobId);
    var pendingFile = createPendingFile(storage, jobId, '');
    var lockFile = createLockFile(storage, jobId);
    try {
      var result = manager.isLocked(pendingFile);
      log('← [JSM-13] isLocked=' + result);
      expect(result).to.equal(true);
    } finally {
      try { pendingFile.setTrashed(true); } catch (e) {}
      try { lockFile.setTrashed(true); } catch (e) {}
    }
  });

  it('[JSM-14] isLocked returns false when RUNNING-{differentJobId}.json exists (no match)', function() {
    var jobIdA = 'jsmisl14a' + Date.now();
    var jobIdB = 'jsmisl14b' + Date.now();
    log('→ [JSM-14] isLocked | pendingJobId=' + jobIdA + ' lockJobId=' + jobIdB + ' (no match)');
    var pendingFileA = createPendingFile(storage, jobIdA, '');
    var lockFileB = createLockFile(storage, jobIdB);
    try {
      // Lock is for B, not A → A is not locked
      var result = manager.isLocked(pendingFileA);
      log('← [JSM-14] isLocked=' + result);
      expect(result).to.equal(false);
    } finally {
      try { pendingFileA.setTrashed(true); } catch (e) {}
      try { lockFileB.setTrashed(true); } catch (e) {}
    }
  });

});

// ============================================================================
// JSM-15..16: hasPendingJobs
// ============================================================================

describe('JobStateManager [PENDING] — hasPendingJobs', function() {

  var storage;
  var manager;

  before(function() {
    storage = makeStorage('pending-' + Date.now());
    manager = new JobStateManager({ driveStorage: storage });
    log('→ [JSM-PENDING before] root=' + storage.rootFolderName + ' clearing jobs folder');
    // Ensure jobs folder is empty at start
    var files = storage.getFolder('jobs').getFiles();
    while (files.hasNext()) { try { files.next().setTrashed(true); } catch (e) {} }
    log('← [JSM-PENDING before] jobs folder cleared');
  });

  after(function() {
    log('→ [JSM-PENDING after] cleanup root=' + storage.rootFolderName);
    try {
      var folders = DriveApp.getFoldersByName(storage.rootFolderName);
      while (folders.hasNext()) { folders.next().setTrashed(true); }
    } catch (e) {}
  });

  it('[JSM-15] hasPendingJobs returns false when jobs folder is empty', function() {
    log('→ [JSM-15] hasPendingJobs | jobs=empty');
    var result = manager.hasPendingJobs();
    log('← [JSM-15] hasPendingJobs=' + result);
    expect(result).to.equal(false);
  });

  it('[JSM-16] hasPendingJobs returns true after a job is created', function() {
    var jobId = 'jsm-pend-' + Date.now();
    log('→ [JSM-16] createPendingFile then hasPendingJobs | jobId=' + jobId);
    var file = createPendingFile(storage, jobId, '');
    try {
      var result = manager.hasPendingJobs();
      log('← [JSM-16] hasPendingJobs=' + result + ' file=' + file.getName());
      expect(result).to.equal(true);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

});
}
__defineModule__(_main);
