function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var JobStateManagerModule = require('then-later/storage/JobStateManager');

var describe = mocha.describe;
var it = mocha.it;
var expect = chai.expect;

var FileUtils = JobStateManagerModule.FileUtils;

var log = function(msg) { Logger.log(msg); };

// ============================================================================
// FU-01..08: parseJobFilename
// ============================================================================

describe('FileUtils [PARSE] — parseJobFilename', function() {

  it('[FU-01] PENDING-abc123.json → correct state, jobId, empty description', function() {
    log('→ [FU-01] parseJobFilename("PENDING-abc123.json")');
    var result = FileUtils.parseJobFilename('PENDING-abc123.json');
    log('← [FU-01] state=' + (result && result.state) + ' jobId=' + (result && result.jobId) + ' desc="' + (result && result.description) + '"');
    expect(result).to.not.equal(null);
    expect(result.state).to.equal('PENDING');
    expect(result.jobId).to.equal('abc123');
    expect(result.description).to.equal('');
  });

  it('[FU-02] RUNNING-abc123-my_description.json → description populated', function() {
    log('→ [FU-02] parseJobFilename("RUNNING-abc123-my_description.json")');
    var result = FileUtils.parseJobFilename('RUNNING-abc123-my_description.json');
    log('← [FU-02] state=' + (result && result.state) + ' jobId=' + (result && result.jobId) + ' desc="' + (result && result.description) + '"');
    expect(result).to.not.equal(null);
    expect(result.state).to.equal('RUNNING');
    expect(result.jobId).to.equal('abc123');
    expect(result.description).to.equal('my_description');
  });

  it('[FU-03] SUCCESS-abc123-desc-with-hyphens.json → hyphens in description allowed', function() {
    log('→ [FU-03] parseJobFilename("SUCCESS-abc123-desc-with-hyphens.json")');
    var result = FileUtils.parseJobFilename('SUCCESS-abc123-desc-with-hyphens.json');
    log('← [FU-03] state=' + (result && result.state) + ' desc="' + (result && result.description) + '"');
    expect(result).to.not.equal(null);
    expect(result.state).to.equal('SUCCESS');
    expect(result.jobId).to.equal('abc123');
    expect(result.description).to.equal('desc-with-hyphens');
  });

  it('[FU-04] no .json extension → null', function() {
    log('→ [FU-04] parseJobFilename("PENDING-abc123") — no extension → expect null');
    var result = FileUtils.parseJobFilename('PENDING-abc123');
    log('← [FU-04] result=' + result);
    expect(result).to.equal(null);
  });

  it('[FU-05] lowercase state "pending-abc123.json" → null (state must be uppercase)', function() {
    log('→ [FU-05] parseJobFilename("pending-abc123.json") — lowercase state → expect null');
    var result = FileUtils.parseJobFilename('pending-abc123.json');
    log('← [FU-05] result=' + result);
    expect(result).to.equal(null);
  });

  it('[FU-06] empty string → null', function() {
    log('→ [FU-06] parseJobFilename("") → expect null');
    var result = FileUtils.parseJobFilename('');
    log('← [FU-06] result=' + result);
    expect(result).to.equal(null);
  });

  it('[FU-07] fullFilename field equals the original input filename', function() {
    var filename = 'FAILED-xyz789-some_desc.json';
    log('→ [FU-07] parseJobFilename("' + filename + '") → check fullFilename');
    var result = FileUtils.parseJobFilename(filename);
    log('← [FU-07] fullFilename="' + (result && result.fullFilename) + '"');
    expect(result).to.not.equal(null);
    expect(result.fullFilename).to.equal(filename);
  });

  it('[FU-08] DELAYED-xyz789.json → DELAYED state parsed correctly', function() {
    log('→ [FU-08] parseJobFilename("DELAYED-xyz789.json")');
    var result = FileUtils.parseJobFilename('DELAYED-xyz789.json');
    log('← [FU-08] state=' + (result && result.state) + ' jobId=' + (result && result.jobId));
    expect(result).to.not.equal(null);
    expect(result.state).to.equal('DELAYED');
    expect(result.jobId).to.equal('xyz789');
    expect(result.description).to.equal('');
  });

});

// ============================================================================
// FU-09..13: createJobFilename
// ============================================================================

describe('FileUtils [CREATE] — createJobFilename', function() {

  it('[FU-09] no description → "STATE-jobId.json"', function() {
    log('→ [FU-09] createJobFilename("PENDING", "abc123") — no desc');
    var result = FileUtils.createJobFilename('PENDING', 'abc123');
    log('← [FU-09] result="' + result + '"');
    expect(result).to.equal('PENDING-abc123.json');
  });

  it('[FU-10] description with spaces → spaces replaced by underscores', function() {
    log('→ [FU-10] createJobFilename("PENDING", "abc123", "hello world") — spaces→underscores');
    var result = FileUtils.createJobFilename('PENDING', 'abc123', 'hello world');
    log('← [FU-10] result="' + result + '"');
    expect(result).to.equal('PENDING-abc123-hello_world.json');
  });

  it('[FU-11] description longer than 20 chars is truncated to 20', function() {
    log('→ [FU-11] createJobFilename with 31-char desc → truncate to 20');
    var result = FileUtils.createJobFilename('PENDING', 'abc123', 'this_is_a_very_long_description');
    log('← [FU-11] result="' + result + '"');
    expect(result).to.equal('PENDING-abc123-this_is_a_very_long_.json');
  });

  it('[FU-12] special chars in description are sanitized to underscores', function() {
    log('→ [FU-12] createJobFilename with "test!@#$%" — special chars → underscores');
    var result = FileUtils.createJobFilename('PENDING', 'abc123', 'test!@#$%');
    log('← [FU-12] result="' + result + '"');
    expect(result).to.equal('PENDING-abc123-test_____.json');
  });

  it('[FU-13] alphanumeric, underscores, hyphens are preserved', function() {
    log('→ [FU-13] createJobFilename("RUNNING", "abc123", "my-task_v2") — preserved chars');
    var result = FileUtils.createJobFilename('RUNNING', 'abc123', 'my-task_v2');
    log('← [FU-13] result="' + result + '"');
    expect(result).to.equal('RUNNING-abc123-my-task_v2.json');
  });

});

// ============================================================================
// FU-14..16: generateJobId
// ============================================================================

describe('FileUtils [GENID] — generateJobId', function() {

  it('[FU-14] generateJobId returns a non-empty string', function() {
    log('→ [FU-14] generateJobId()');
    var id = FileUtils.generateJobId();
    log('← [FU-14] id="' + id + '" len=' + id.length);
    expect(id).to.be.a('string');
    expect(id.length).to.be.greaterThan(0);
  });

  it('[FU-15] two consecutive generateJobId calls produce different values', function() {
    log('→ [FU-15] generateJobId() × 2 → compare');
    var id1 = FileUtils.generateJobId();
    var id2 = FileUtils.generateJobId();
    log('← [FU-15] id1=' + id1 + ' id2=' + id2 + ' equal=' + (id1 === id2));
    expect(id1).to.not.equal(id2);
  });

  it('[FU-16] generateJobId result matches /^[a-z0-9]+$/ (lowercase base36)', function() {
    log('→ [FU-16] generateJobId() → check /^[a-z0-9]+$/');
    var id = FileUtils.generateJobId();
    var matches = /^[a-z0-9]+$/.test(id);
    log('← [FU-16] id=' + id + ' matchesPattern=' + matches);
    expect(matches).to.equal(true);
  });

});
}
__defineModule__(_main);
