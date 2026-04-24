function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var DriveStorageModule = require('then-later/storage/DriveStorage');
var JobStateManagerModule = require('then-later/storage/JobStateManager');
var JobRepositoryModule = require('then-later/storage/JobRepository');

var describe = mocha.describe;
var it = mocha.it;
var before = mocha.beforeAll;
var after = mocha.afterAll;
var expect = chai.expect;

var DriveStorage = DriveStorageModule.DriveStorage;
var JOB_STATES = JobStateManagerModule.JOB_STATES;
var FileUtils = JobStateManagerModule.FileUtils;
var JobRepository = JobRepositoryModule.JobRepository;
var NoResultsFoundError = JobRepositoryModule.NoResultsFoundError;
var JobValidationError = JobRepositoryModule.JobValidationError;

var log = function(msg) { Logger.log(msg); };

// ============================================================================
// Helpers
// ============================================================================

function makeStorage(suffix) {
  var storage = new DriveStorage({ rootFolderName: 'ScheduledScripts-jr-' + suffix });
  storage.initialize();
  return storage;
}

function trashAllInFolder(storage, folderType) {
  try {
    var files = storage.getFolder(folderType).getFiles();
    while (files.hasNext()) { try { files.next().setTrashed(true); } catch (e) {} }
  } catch (e) {}
}

function trashStorage(storage) {
  try {
    var folders = DriveApp.getFoldersByName(storage.rootFolderName);
    while (folders.hasNext()) { folders.next().setTrashed(true); }
  } catch (e) {}
}

function makeRepo(storage) {
  return new JobRepository({ driveStorage: storage });
}

function makeMinimalJob(jobId, functionPath) {
  return {
    jobId: jobId || FileUtils.generateJobId(),
    steps: [{ functionPath: functionPath || 'Math.random', parameters: [] }],
    metadata: { created: new Date().toISOString() }
  };
}

// ============================================================================
// JR-01..03: Error class constructors (no Drive)
// ============================================================================

describe('JobRepository [ERR] — error class constructors', function() {

  it('[JR-01] NoResultsFoundError has correct name and message', function() {
    log('→ [JR-01] new NoResultsFoundError("myFn", "myTag")');
    var err = new NoResultsFoundError('myFn', 'myTag');
    log('← [JR-01] name=' + err.name + ' msg includes fn=' + err.message.includes('myFn'));
    expect(err.name).to.equal('NoResultsFoundError');
    expect(err.message).to.include('myFn');
    expect(err.message).to.include('myTag');
  });

  it('[JR-02] NoResultsFoundError without tag omits tag from message', function() {
    log('→ [JR-02] new NoResultsFoundError("myFn", null)');
    var err = new NoResultsFoundError('myFn', null);
    log('← [JR-02] name=' + err.name + ' msg=' + err.message);
    expect(err.name).to.equal('NoResultsFoundError');
    expect(err.message).to.include('myFn');
  });

  it('[JR-03] JobValidationError has correct name and wraps message', function() {
    log('→ [JR-03] new JobValidationError("bad field")');
    var err = new JobValidationError('bad field');
    log('← [JR-03] name=' + err.name + ' msg=' + err.message);
    expect(err.name).to.equal('JobValidationError');
    expect(err.message).to.include('bad field');
  });

});

// ============================================================================
// JR-04..08: validateJobStructure (no Drive)
// ============================================================================

describe('JobRepository [VALIDATE] — validateJobStructure', function() {

  var storage;
  var repo;

  before(function() {
    storage = makeStorage('validate-' + Date.now());
    repo = makeRepo(storage);
    log('→ [JR-VALIDATE before] root=' + storage.rootFolderName);
  });

  after(function() { trashStorage(storage); });

  it('[JR-04] valid job structure does not throw', function() {
    log('→ [JR-04] validateJobStructure(valid) → no throw');
    var threw = false;
    try {
      repo.validateJobStructure({
        steps: [{ functionPath: 'Math.random', parameters: [] }]
      });
    } catch (e) { threw = true; }
    log('← [JR-04] threw=' + threw);
    expect(threw).to.equal(false);
  });

  it('[JR-05] null job throws JobValidationError', function() {
    log('→ [JR-05] validateJobStructure(null) → JobValidationError');
    var threw = false;
    var errName = null;
    try { repo.validateJobStructure(null); }
    catch (e) { threw = true; errName = e.name; }
    log('← [JR-05] threw=' + threw + ' name=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('JobValidationError');
  });

  it('[JR-06] missing steps array throws JobValidationError', function() {
    log('→ [JR-06] validateJobStructure({notSteps}) → JobValidationError');
    var threw = false;
    var errName = null;
    try { repo.validateJobStructure({ notSteps: [] }); }
    catch (e) { threw = true; errName = e.name; }
    log('← [JR-06] threw=' + threw + ' name=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('JobValidationError');
  });

  it('[JR-07] step missing functionPath throws JobValidationError', function() {
    log('→ [JR-07] validateJobStructure(step without functionPath) → JobValidationError');
    var threw = false;
    var errName = null;
    try {
      repo.validateJobStructure({ steps: [{ parameters: [] }] });
    } catch (e) { threw = true; errName = e.name; }
    log('← [JR-07] threw=' + threw + ' name=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('JobValidationError');
  });

  it('[JR-08] step with non-array parameters throws JobValidationError', function() {
    log('→ [JR-08] validateJobStructure(parameters=string) → JobValidationError');
    var threw = false;
    var errName = null;
    try {
      repo.validateJobStructure({
        steps: [{ functionPath: 'Math.random', parameters: 'not-array' }]
      });
    } catch (e) { threw = true; errName = e.name; }
    log('← [JR-08] threw=' + threw + ' name=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('JobValidationError');
  });

});

// ============================================================================
// JR-09..14: matchesCriteria (no Drive, pure data)
// ============================================================================

describe('JobRepository [MATCH] — matchesCriteria', function() {

  var storage;
  var repo;

  before(function() {
    storage = makeStorage('match-' + Date.now());
    repo = makeRepo(storage);
    log('→ [JR-MATCH before] root=' + storage.rootFolderName);
  });

  after(function() { trashStorage(storage); });

  function makeResultContent(functionPath, tags) {
    return {
      metadata: {
        originalJob: {
          jobId: 'test-job',
          steps: [{ functionPath: functionPath, parameters: [] }],
          metadata: { tags: tags || [] }
        }
      }
    };
  }

  it('[JR-09] matches by functionPath with no tag requirement', function() {
    log('→ [JR-09] matchesCriteria(Math.random, null) with matching fn, no tag required');
    var result = repo.matchesCriteria(makeResultContent('Math.random', []), 'Math.random', null);
    log('← [JR-09] result=' + result);
    expect(result).to.equal(true);
  });

  it('[JR-10] matches by functionPath with matching tag', function() {
    log('→ [JR-10] matchesCriteria(Math.random, "my-tag") with tag in array');
    var result = repo.matchesCriteria(makeResultContent('Math.random', ['my-tag']), 'Math.random', 'my-tag');
    log('← [JR-10] result=' + result);
    expect(result).to.equal(true);
  });

  it('[JR-11] does not match when tag is required but absent from tags array', function() {
    log('→ [JR-11] matchesCriteria(Math.random, "my-tag") tags=["other-tag"] → no match');
    var result = repo.matchesCriteria(makeResultContent('Math.random', ['other-tag']), 'Math.random', 'my-tag');
    log('← [JR-11] result=' + result);
    expect(result).to.equal(false);
  });

  it('[JR-12] does not match when functionPath is wrong', function() {
    log('→ [JR-12] matchesCriteria(Math.random, null) content has Math.floor → no match');
    var result = repo.matchesCriteria(makeResultContent('Math.floor', []), 'Math.random', null);
    log('← [JR-12] result=' + result);
    expect(result).to.equal(false);
  });

  it('[JR-13] returns false when metadata is null', function() {
    log('→ [JR-13] matchesCriteria(null, Math.random, null)');
    var result = repo.matchesCriteria(null, 'Math.random', null);
    log('← [JR-13] result=' + result);
    expect(result).to.equal(false);
  });

  it('[JR-14] returns false when originalJob.steps is not an array', function() {
    log('→ [JR-14] matchesCriteria(steps=string) → false');
    var content = {
      metadata: {
        originalJob: { steps: 'not-array', metadata: { tags: [] } }
      }
    };
    var result = repo.matchesCriteria(content, 'Math.random', null);
    log('← [JR-14] result=' + result);
    expect(result).to.equal(false);
  });

});

// ============================================================================
// JR-15..17: formatResult (no Drive, pure data)
// ============================================================================

describe('JobRepository [FORMAT] — formatResult', function() {

  var storage;
  var repo;

  before(function() {
    storage = makeStorage('format-' + Date.now());
    repo = makeRepo(storage);
    log('→ [JR-FORMAT before] root=' + storage.rootFolderName);
  });

  after(function() { trashStorage(storage); });

  it('[JR-15] success=true returns [content.results, metadata with success:true]', function() {
    log('→ [JR-15] formatResult(success=true, results=[42,"hello"])');
    var content = {
      results: [42, 'hello'],
      metadata: { originalJob: { jobId: 'test-id', steps: [] } }
    };
    var pair = repo.formatResult(content, true, 'SUCCESS-test-id.json');
    log('← [JR-15] results=' + JSON.stringify(pair[0]) + ' success=' + pair[1].success);
    expect(pair[0]).to.deep.equal([42, 'hello']);
    expect(pair[1].success).to.equal(true);
  });

  it('[JR-16] success=false returns [content.error, metadata with success:false]', function() {
    log('→ [JR-16] formatResult(success=false, error={message})');
    var content = {
      error: { message: 'something went wrong' },
      metadata: { originalJob: { jobId: 'test-id', steps: [] } }
    };
    var pair = repo.formatResult(content, false, 'FAILED-test-id.json');
    log('← [JR-16] error.message=' + pair[0].message + ' success=' + pair[1].success);
    expect(pair[0]).to.deep.equal({ message: 'something went wrong' });
    expect(pair[1].success).to.equal(false);
  });

  it('[JR-17] metadata.jobId is populated from originalJob.jobId', function() {
    log('→ [JR-17] formatResult → metadata.jobId from originalJob.jobId');
    var content = {
      results: [],
      metadata: { originalJob: { jobId: 'actual-job-id', steps: [] } }
    };
    var pair = repo.formatResult(content, true, 'SUCCESS-actual-job-id.json');
    log('← [JR-17] metadata.jobId=' + pair[1].jobId);
    expect(pair[1].jobId).to.equal('actual-job-id');
  });

});

// ============================================================================
// JR-18..20: createJob (Drive)
// ============================================================================

describe('JobRepository [CREATE] — createJob', function() {

  var storage;
  var repo;

  before(function() {
    storage = makeStorage('create-' + Date.now());
    repo = makeRepo(storage);
    log('→ [JR-CREATE before] root=' + storage.rootFolderName);
  });

  after(function() { trashStorage(storage); });

  it('[JR-18] createJob creates a PENDING-{id}.json file in jobs folder', function() {
    var jobId = 'jr-create-' + Date.now();
    log('→ [JR-18] createJob | jobId=' + jobId + ' fn=Math.random');
    var file = repo.createJob(makeMinimalJob(jobId));
    try {
      log('← [JR-18] file=' + file.getName());
      expect(file).to.not.equal(null);
      expect(file.getName()).to.include(jobId);
      expect(file.getName().indexOf('PENDING')).to.be.greaterThan(-1);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

  it('[JR-19] createJob auto-generates jobId when not provided', function() {
    log('→ [JR-19] createJob(no jobId) → auto-generates jobId');
    var job = makeMinimalJob(null);
    delete job.jobId;
    var file = repo.createJob(job);
    try {
      var content = JSON.parse(file.getBlob().getDataAsString());
      log('← [JR-19] file=' + file.getName() + ' jobId=' + content.jobId);
      expect(content.jobId).to.be.a('string');
      expect(content.jobId.length).to.be.greaterThan(0);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

  it('[JR-20] createJob adds metadata.created timestamp', function() {
    log('→ [JR-20] createJob(no created) → auto-adds metadata.created');
    var job = { steps: [{ functionPath: 'Math.random', parameters: [] }], metadata: {} };
    var file = repo.createJob(job);
    try {
      var content = JSON.parse(file.getBlob().getDataAsString());
      log('← [JR-20] file=' + file.getName() + ' created=' + content.metadata.created);
      expect(content.metadata.created).to.be.a('string');
      expect(content.metadata.created.length).to.be.greaterThan(0);
    } finally {
      try { file.setTrashed(true); } catch (e) {}
    }
  });

});

// ============================================================================
// JR-21..25: pickup / peek (Drive)
// ============================================================================

describe('JobRepository [PICKUP] — pickup and peek', function() {

  var storage;
  var repo;

  before(function() {
    storage = makeStorage('pickup-' + Date.now());
    repo = makeRepo(storage);
    log('→ [JR-PICKUP before] root=' + storage.rootFolderName);
  });

  after(function() { trashStorage(storage); });

  it('[JR-21] pickup on empty results throws NoResultsFoundError', function() {
    log('→ [JR-21] pickup("Math.random", null) on empty results → NoResultsFoundError');
    var threw = false;
    var errName = null;
    try { repo.pickup('Math.random', null); }
    catch (e) { threw = true; errName = e.name; }
    log('← [JR-21] threw=' + threw + ' name=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('NoResultsFoundError');
  });

  it('[JR-22] peek on empty results returns [null, null]', function() {
    log('→ [JR-22] peek("Math.random", null) on empty results → [null,null]');
    var pair = repo.peek('Math.random', null);
    log('← [JR-22] pair=[' + pair[0] + ',' + pair[1] + ']');
    expect(pair[0]).to.equal(null);
    expect(pair[1]).to.equal(null);
  });

  it('[JR-23] pickup finds a seeded SUCCESS file and returns result', function() {
    var jobId = 'jr-pickup-' + Date.now();
    log('→ [JR-23] seed SUCCESS file + pickup | jobId=' + jobId + ' fn=Math.abs results=[99]');
    var content = {
      results: [99],
      state: JOB_STATES.SUCCESS,
      metadata: {
        originalJob: {
          jobId: jobId,
          steps: [{ functionPath: 'Math.abs', parameters: [] }],
          metadata: { tags: [jobId] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.SUCCESS, jobId, '');
    storage.getFolder('results').createFile(filename, JSON.stringify(content));

    var pair = repo.pickup('Math.abs', jobId);
    log('← [JR-23] results[0]=' + pair[0][0] + ' success=' + pair[1].success);
    expect(Array.isArray(pair[0])).to.equal(true);
    expect(pair[0][0]).to.equal(99);
    expect(pair[1].success).to.equal(true);
  });

  it('[JR-24] pickup deletes the result file by default', function() {
    var jobId = 'jr-pickup-del-' + Date.now();
    log('→ [JR-24] seed + pickup(keepFile=false) | jobId=' + jobId);
    var content = {
      results: [1],
      state: JOB_STATES.SUCCESS,
      metadata: {
        originalJob: {
          jobId: jobId,
          steps: [{ functionPath: 'Math.ceil', parameters: [] }],
          metadata: { tags: [jobId] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.SUCCESS, jobId, '');
    storage.getFolder('results').createFile(filename, JSON.stringify(content));
    repo.pickup('Math.ceil', jobId); // default keepFile=false

    // File should be gone
    var files = storage.getFolder('results').getFiles();
    var found = false;
    while (files.hasNext()) {
      if (files.next().getName().indexOf(jobId) !== -1) { found = true; break; }
    }
    log('← [JR-24] fileStillPresent=' + found);
    expect(found).to.equal(false);
  });

  it('[JR-25] pickup with keepFile=true leaves the result file in place', function() {
    var jobId = 'jr-pickup-keep-' + Date.now();
    log('→ [JR-25] seed + pickup(keepFile=true) | jobId=' + jobId);
    var content = {
      results: [2],
      state: JOB_STATES.SUCCESS,
      metadata: {
        originalJob: {
          jobId: jobId,
          steps: [{ functionPath: 'Math.floor', parameters: [] }],
          metadata: { tags: [jobId] }
        }
      }
    };
    var filename = FileUtils.createJobFilename(JOB_STATES.SUCCESS, jobId, '');
    var seededFile = storage.getFolder('results').createFile(filename, JSON.stringify(content));
    repo.pickup('Math.floor', jobId, true); // keepFile=true

    var files = storage.getFolder('results').getFiles();
    var found = false;
    while (files.hasNext()) {
      if (files.next().getName().indexOf(jobId) !== -1) { found = true; break; }
    }
    log('← [JR-25] fileStillPresent=' + found);
    expect(found).to.equal(true);
    try { seededFile.setTrashed(true); } catch (e) {}
  });

});

// ============================================================================
// JR-26..27: getJobBatch (Drive)
// ============================================================================

describe('JobRepository [BATCH] — getJobBatch', function() {

  var storage;
  var repo;
  var seededFiles;

  before(function() {
    storage = makeStorage('batch-' + Date.now());
    repo = makeRepo(storage);
    seededFiles = [];
    log('→ [JR-BATCH before] seeding 7 jobs | root=' + storage.rootFolderName);
    for (var i = 0; i < 7; i++) {
      var job = makeMinimalJob('jr-batch-' + Date.now() + '-' + i);
      seededFiles.push(repo.createJob(job));
    }
    log('← [JR-BATCH before] seeded=' + seededFiles.length + ' files');
  });

  after(function() {
    log('→ [JR-BATCH after] trash ' + seededFiles.length + ' files + storage');
    seededFiles.forEach(function(f) { try { f.setTrashed(true); } catch (e) {} });
    trashStorage(storage);
  });

  it('[JR-26] getJobBatch returns at most the specified limit', function() {
    log('→ [JR-26] getJobBatch(3) | total=7 jobs');
    var batch = repo.getJobBatch(3);
    log('← [JR-26] batch.length=' + batch.length);
    expect(batch.length).to.be.most(3);
  });

  it('[JR-27] getJobBatch returns empty array when no jobs exist', function() {
    log('→ [JR-27] getJobBatch(5) on empty storage');
    var emptyStorage = makeStorage('batch-empty-' + Date.now());
    var emptyRepo = makeRepo(emptyStorage);
    try {
      var batch = emptyRepo.getJobBatch(5);
      log('← [JR-27] batch.length=' + batch.length);
      expect(batch).to.deep.equal([]);
    } finally {
      trashStorage(emptyStorage);
    }
  });

});

// ============================================================================
// JR-28..29: findEarliestFutureJobTime (Drive)
// ============================================================================

describe('JobRepository [EARLIEST] — findEarliestFutureJobTime', function() {

  var storage;
  var repo;

  before(function() {
    storage = makeStorage('earliest-' + Date.now());
    repo = makeRepo(storage);
    log('→ [JR-EARLIEST before] root=' + storage.rootFolderName);
  });

  after(function() { trashStorage(storage); });

  it('[JR-28] returns null when no jobs exist', function() {
    log('→ [JR-28] findEarliestFutureJobTime | jobs=empty');
    var result = repo.findEarliestFutureJobTime();
    log('← [JR-28] result=' + result);
    expect(result).to.equal(null);
  });

  it('[JR-29] returns the earliest startEarliestTime of two future jobs', function() {
    var now = Date.now();
    var t1 = new Date(now + 3600000).toISOString(); // 1h
    var t2 = new Date(now + 7200000).toISOString(); // 2h
    log('→ [JR-29] seed 2 future jobs | t1=+1h t2=+2h → expect t1');

    var job1 = makeMinimalJob('jr-early1-' + Date.now());
    job1.metadata.startEarliestTime = t1;
    var job2 = makeMinimalJob('jr-early2-' + Date.now());
    job2.metadata.startEarliestTime = t2;

    var f1 = repo.createJob(job1);
    var f2 = repo.createJob(job2);
    try {
      var earliest = repo.findEarliestFutureJobTime();
      log('← [JR-29] earliest=' + (earliest ? earliest.toISOString() : 'null') + ' t1=' + t1);
      expect(earliest).to.not.equal(null);
      // t1 is earlier → earliest should be approximately t1
      expect(Math.abs(earliest.getTime() - new Date(t1).getTime())).to.be.lessThan(1000);
    } finally {
      try { f1.setTrashed(true); } catch (e) {}
      try { f2.setTrashed(true); } catch (e) {}
    }
  });

});
}
__defineModule__(_main);
