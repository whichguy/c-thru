function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var DriveStorageModule = require('then-later/storage/DriveStorage');

var describe = mocha.describe;
var it = mocha.it;
var before = mocha.beforeAll;
var after = mocha.afterAll;
var expect = chai.expect;

var DriveStorage = DriveStorageModule.DriveStorage;

var log = function(msg) { Logger.log(msg); };

// ============================================================================
// Helpers
// ============================================================================

function makeStorage(suffix) {
  return new DriveStorage({
    rootFolderName: 'ScheduledScripts-test-' + suffix
  });
}

function trashFolder(folderName) {
  try {
    var folders = DriveApp.getFoldersByName(folderName);
    while (folders.hasNext()) {
      folders.next().setTrashed(true);
    }
  } catch (e) {}
}

// ============================================================================
// DS-01..03: Initialization
// ============================================================================

describe('DriveStorage [INIT] — initialization', function() {

  var rootName;
  var storage;

  before(function() {
    rootName = 'ScheduledScripts-test-init-' + Date.now();
    log('→ [DS-INIT before] rootName=' + rootName);
    storage = new DriveStorage({ rootFolderName: rootName });
    log('← [DS-INIT before] initialized=' + storage.initialized);
  });

  after(function() {
    log('→ [DS-INIT after] trash rootName=' + rootName);
    try { trashFolder(rootName); } catch (e) {}
  });

  it('[DS-01] new DriveStorage() constructs without error; initialized === false', function() {
    log('→ [DS-01] check initialized before init');
    log('← [DS-01] initialized=' + storage.initialized);
    expect(storage.initialized).to.equal(false);
  });

  it('[DS-02] initialize() sets initialized = true', function() {
    log('→ [DS-02] storage.initialize()');
    storage.initialize();
    log('← [DS-02] initialized=' + storage.initialized);
    expect(storage.initialized).to.equal(true);
  });

  it('[DS-03] second initialize() is idempotent; initialized remains true', function() {
    log('→ [DS-03] storage.initialize() again');
    storage.initialize();
    log('← [DS-03] initialized=' + storage.initialized);
    expect(storage.initialized).to.equal(true);
  });

});

// ============================================================================
// DS-04..08: getFolder
// ============================================================================

describe('DriveStorage [FOLDER] — getFolder returns correct folders', function() {

  var rootName;
  var storage;

  before(function() {
    rootName = 'ScheduledScripts-test-folder-' + Date.now();
    log('→ [DS-FOLDER before] rootName=' + rootName);
    storage = new DriveStorage({ rootFolderName: rootName });
    storage.initialize();
    log('← [DS-FOLDER before] initialized');
  });

  after(function() {
    log('→ [DS-FOLDER after] trash rootName=' + rootName);
    try { trashFolder(rootName); } catch (e) {}
  });

  it('[DS-04] getFolder("jobs") returns a Folder object', function() {
    log('→ [DS-04] getFolder("jobs")');
    var folder = storage.getFolder('jobs');
    log('← [DS-04] id=' + folder.getId());
    expect(folder).to.not.equal(null);
    expect(typeof folder.getFiles).to.equal('function');
  });

  it('[DS-05] getFolder("locks") returns a Folder object', function() {
    log('→ [DS-05] getFolder("locks")');
    var folder = storage.getFolder('locks');
    log('← [DS-05] id=' + folder.getId());
    expect(folder).to.not.equal(null);
    expect(typeof folder.getFiles).to.equal('function');
  });

  it('[DS-06] getFolder("results") returns a Folder object', function() {
    log('→ [DS-06] getFolder("results")');
    var folder = storage.getFolder('results');
    log('← [DS-06] id=' + folder.getId());
    expect(folder).to.not.equal(null);
    expect(typeof folder.getFiles).to.equal('function');
  });

  it('[DS-07] getFolder("deadLetters") returns a Folder object', function() {
    log('→ [DS-07] getFolder("deadLetters")');
    var folder = storage.getFolder('deadLetters');
    log('← [DS-07] id=' + folder.getId());
    expect(folder).to.not.equal(null);
    expect(typeof folder.getFiles).to.equal('function');
  });

  it('[DS-08] getFolder("unknown") throws an error', function() {
    log('→ [DS-08] getFolder("unknown") → expect throw');
    var threw = false;
    try {
      storage.getFolder('unknown');
    } catch (e) {
      threw = true;
      log('← [DS-08] threw=' + threw + ' err=' + e.message);
    }
    expect(threw).to.equal(true);
  });

});

// ============================================================================
// DS-09: Memory cache hit
// ============================================================================

describe('DriveStorage [CACHE] — memory cache behavior', function() {

  var rootName;
  var storage;

  before(function() {
    rootName = 'ScheduledScripts-test-cache-' + Date.now();
    log('→ [DS-CACHE before] rootName=' + rootName);
    storage = new DriveStorage({ rootFolderName: rootName });
    storage.initialize();
    log('← [DS-CACHE before] initialized');
  });

  after(function() {
    log('→ [DS-CACHE after] trash rootName=' + rootName);
    try { trashFolder(rootName); } catch (e) {}
  });

  it('[DS-09] second getFolder("jobs") returns same Folder object (memory cache hit)', function() {
    log('→ [DS-09] getFolder("jobs") × 2 → check cache');
    var folder1 = storage.getFolder('jobs');
    var folder2 = storage.getFolder('jobs');
    log('← [DS-09] id1=' + folder1.getId() + ' id2=' + folder2.getId() + ' match=' + (folder1.getId() === folder2.getId()));
    // Same folder — both must point to same Drive folder (same ID)
    expect(folder1.getId()).to.equal(folder2.getId());
  });

});

// ============================================================================
// DS-10..12: getCacheStats / clearCache
// ============================================================================

describe('DriveStorage [STATS] — getCacheStats and clearCache', function() {

  var rootName;
  var storage;

  before(function() {
    rootName = 'ScheduledScripts-test-stats-' + Date.now();
    log('→ [DS-STATS before] rootName=' + rootName);
    storage = new DriveStorage({ rootFolderName: rootName });
    storage.initialize();
    // Warm up cache
    storage.getFolder('jobs');
    storage.getFolder('locks');
    log('← [DS-STATS before] cache warmed');
  });

  after(function() {
    log('→ [DS-STATS after] trash rootName=' + rootName);
    try { trashFolder(rootName); } catch (e) {}
  });

  it('[DS-10] getCacheStats() returns object with memorySize and memoryCached', function() {
    log('→ [DS-10] getCacheStats()');
    var stats = storage.getCacheStats();
    log('← [DS-10] memorySize=' + stats.memorySize + ' memoryCached=' + stats.memoryCached);
    expect(stats).to.be.an('object');
    expect(stats).to.have.property('memorySize');
    expect(stats).to.have.property('memoryCached');
    expect(stats.memorySize).to.be.greaterThan(0);
  });

  it('[DS-11] clearCache() resets the memory cache to empty', function() {
    log('→ [DS-11] clearCache()');
    storage.clearCache();
    var stats = storage.getCacheStats();
    log('← [DS-11] memorySize=' + stats.memorySize);
    expect(stats.memorySize).to.equal(0);
  });

  it('[DS-12] getFolder still works after clearCache (re-fetches from Drive)', function() {
    log('→ [DS-12] clearCache() then getFolder("jobs")');
    storage.clearCache();
    var folder = storage.getFolder('jobs');
    log('← [DS-12] folder.id=' + folder.getId());
    expect(folder).to.not.equal(null);
    expect(typeof folder.getFiles).to.equal('function');
  });

});
}
__defineModule__(_main);
