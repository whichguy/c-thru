function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var JobSchedulerModule = require('then-later/core/JobScheduler');

var describe = mocha.describe;
var it = mocha.it;
var before = mocha.beforeAll;
var after = mocha.afterAll;
var expect = chai.expect;

var JobScheduler = JobSchedulerModule.JobScheduler;
var JobBuilder = JobSchedulerModule.JobBuilder;
var FunctionPathError = JobSchedulerModule.FunctionPathError;

var log = function(msg) { Logger.log(msg); };

// ============================================================================
// JB-01..02: JobBuilder constructor validation (no Drive after scheduler construction)
// ============================================================================

describe('JobBuilder [CTOR] — constructor validation', function() {

  it('[JB-01] new JobBuilder(null) throws', function() {
    log('→ [JB-01] new JobBuilder(null) → expect throw');
    var threw = false;
    try { new JobBuilder(null); }
    catch (e) { threw = true; log('← [JB-01] threw=' + threw + ' err=' + e.message); }
    expect(threw).to.equal(true);
  });

  it('[JB-02] new JobBuilder({}) (plain object, not JobScheduler) throws', function() {
    log('→ [JB-02] new JobBuilder({}) → expect throw');
    var threw = false;
    try { new JobBuilder({}); }
    catch (e) { threw = true; log('← [JB-02] threw=' + threw + ' err=' + e.message); }
    expect(threw).to.equal(true);
  });

});

// ============================================================================
// JB-03..08: create() and thenAfter() chain (Drive needed for scheduler construction)
// ============================================================================

describe('JobBuilder [CHAIN] — create() and thenAfter() chaining', function() {

  var scheduler;

  before(function() {
    log('→ [JB-CHAIN before] new JobScheduler()');
    scheduler = new JobScheduler();
    log('← [JB-CHAIN before] initialized');
  });

  it('[JB-03] scheduler.create() returns a JobBuilder', function() {
    log('→ [JB-03] scheduler.create("Math.random")');
    var builder = scheduler.create('Math.random');
    log('← [JB-03] instanceof JobBuilder=' + (builder instanceof JobBuilder));
    expect(builder instanceof JobBuilder).to.equal(true);
  });

  it('[JB-04] builder.job.jobId is set after create()', function() {
    log('→ [JB-04] scheduler.create("Math.random").job.jobId');
    var builder = scheduler.create('Math.random');
    log('← [JB-04] jobId=' + builder.job.jobId + ' len=' + builder.job.jobId.length);
    expect(builder.job.jobId).to.be.a('string');
    expect(builder.job.jobId.length).to.be.greaterThan(0);
  });

  it('[JB-05] create() adds first step; steps.length === 1', function() {
    log('→ [JB-05] scheduler.create("Math.random") → steps.length');
    var builder = scheduler.create('Math.random');
    log('← [JB-05] steps.length=' + builder.job.steps.length + ' steps[0].functionPath=' + builder.job.steps[0].functionPath);
    expect(builder.job.steps.length).to.equal(1);
    expect(builder.job.steps[0].functionPath).to.equal('Math.random');
  });

  it('[JB-06] thenAfter() adds a second step', function() {
    log('→ [JB-06] create("Math.random").thenAfter("Math.abs") → steps.length');
    var builder = scheduler.create('Math.random').thenAfter('Math.abs', 0);
    log('← [JB-06] steps.length=' + builder.job.steps.length + ' steps[1].functionPath=' + builder.job.steps[1].functionPath);
    expect(builder.job.steps.length).to.equal(2);
    expect(builder.job.steps[1].functionPath).to.equal('Math.abs');
  });

  it('[JB-07] thenAfter() with invalid path throws FunctionPathError', function() {
    log('→ [JB-07] thenAfter("nonExistentFnXYZ") → expect FunctionPathError');
    var threw = false;
    var errName = null;
    try {
      scheduler.create('Math.random').thenAfter('nonExistentFnXYZ');
    } catch (e) {
      threw = true;
      errName = e.name;
    }
    log('← [JB-07] threw=' + threw + ' errName=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('FunctionPathError');
  });

  it('[JB-08] create() with invalid path throws FunctionPathError', function() {
    log('→ [JB-08] create("nonExistentFnXYZ") → expect FunctionPathError');
    var threw = false;
    var errName = null;
    try {
      scheduler.create('nonExistentFnXYZ');
    } catch (e) {
      threw = true;
      errName = e.name;
    }
    log('← [JB-08] threw=' + threw + ' errName=' + errName);
    expect(threw).to.equal(true);
    expect(errName).to.equal('FunctionPathError');
  });

});

// ============================================================================
// JB-09..13: withOptions() (pure data manipulation)
// ============================================================================

describe('JobBuilder [OPTIONS] — withOptions()', function() {

  var scheduler;

  before(function() {
    log('→ [JB-OPTIONS before] new JobScheduler()');
    scheduler = new JobScheduler();
    log('← [JB-OPTIONS before] initialized');
  });

  it('[JB-09] withOptions({description}) sets metadata.description', function() {
    log('→ [JB-09] withOptions({description:"my task"})');
    var builder = scheduler.create('Math.random').withOptions({ description: 'my task' });
    log('← [JB-09] metadata.description=' + builder.job.metadata.description);
    expect(builder.job.metadata.description).to.equal('my task');
  });

  it('[JB-10] description longer than 50 chars is truncated to 50', function() {
    var longDesc = 'a'.repeat(60);
    log('→ [JB-10] withOptions({description: 60-char string}) → truncate to 50');
    var builder = scheduler.create('Math.random').withOptions({ description: longDesc });
    log('← [JB-10] description.length=' + builder.job.metadata.description.length);
    expect(builder.job.metadata.description.length).to.equal(50);
  });

  it('[JB-11] withOptions({tags}) sets metadata.tags array', function() {
    log('→ [JB-11] withOptions({tags:["tag1","tag2"]})');
    var builder = scheduler.create('Math.random').withOptions({ tags: ['tag1', 'tag2'] });
    log('← [JB-11] tags=' + JSON.stringify(builder.job.metadata.tags));
    expect(builder.job.metadata.tags).to.deep.equal(['tag1', 'tag2']);
  });

  it('[JB-12] withOptions({maxRetries}) sets metadata.maxRetries', function() {
    log('→ [JB-12] withOptions({maxRetries:3})');
    var builder = scheduler.create('Math.random').withOptions({ maxRetries: 3 });
    log('← [JB-12] maxRetries=' + builder.job.metadata.maxRetries);
    expect(builder.job.metadata.maxRetries).to.equal(3);
  });

  it('[JB-13] withOptions({storeIntermediate}) sets metadata.storeIntermediate', function() {
    log('→ [JB-13] withOptions({storeIntermediate:true})');
    var builder = scheduler.create('Math.random').withOptions({ storeIntermediate: true });
    log('← [JB-13] storeIntermediate=' + builder.job.metadata.storeIntermediate);
    expect(builder.job.metadata.storeIntermediate).to.equal(true);
  });

});

// ============================================================================
// JB-14..15: withDelay() (pure data manipulation)
// ============================================================================

describe('JobBuilder [DELAY] — withDelay()', function() {

  var scheduler;

  before(function() {
    log('→ [JB-DELAY before] new JobScheduler()');
    scheduler = new JobScheduler();
    log('← [JB-DELAY before] initialized');
  });

  it('[JB-14] withDelay(60000) sets a future startEarliestTime', function() {
    log('→ [JB-14] withDelay(60000) → startEarliestTime in ~60s');
    var beforeTime = Date.now();
    var builder = scheduler.create('Math.random').withDelay(60000);
    var startTime = new Date(builder.job.metadata.startEarliestTime).getTime();
    log('← [JB-14] startEarliestTime=' + builder.job.metadata.startEarliestTime + ' delta=' + (startTime - beforeTime) + 'ms');
    expect(startTime).to.be.greaterThan(beforeTime + 59000);
    expect(startTime).to.be.lessThan(beforeTime + 61000);
  });

  it('[JB-15] withDelay sets an ISO 8601 string', function() {
    log('→ [JB-15] withDelay(1000) → startEarliestTime is ISO string');
    var builder = scheduler.create('Math.random').withDelay(1000);
    log('← [JB-15] startEarliestTime=' + builder.job.metadata.startEarliestTime + ' hasT=' + (builder.job.metadata.startEarliestTime.indexOf('T') > -1));
    expect(typeof builder.job.metadata.startEarliestTime).to.equal('string');
    expect(builder.job.metadata.startEarliestTime.indexOf('T')).to.be.greaterThan(-1);
  });

});

// ============================================================================
// JB-16..18: withRepeat() (pure data manipulation)
// ============================================================================

describe('JobBuilder [REPEAT] — withRepeat()', function() {

  var scheduler;

  before(function() {
    log('→ [JB-REPEAT before] new JobScheduler()');
    scheduler = new JobScheduler();
    log('← [JB-REPEAT before] initialized');
  });

  it('[JB-16] withRepeat({mode:"count", count:3}) sets repeat metadata', function() {
    log('→ [JB-16] withRepeat({mode:"count", count:3})');
    var builder = scheduler.create('Math.random').withRepeat({ mode: 'count', count: 3 });
    log('← [JB-16] mode=' + builder.job.metadata.repeat.mode + ' count=' + builder.job.metadata.repeat.count);
    expect(builder.job.metadata.repeat.mode).to.equal('count');
    expect(builder.job.metadata.repeat.count).to.equal(3);
  });

  it('[JB-17] withRepeat({mode:"infinite"}) sets infinite mode', function() {
    log('→ [JB-17] withRepeat({mode:"infinite"})');
    var builder = scheduler.create('Math.random').withRepeat({ mode: 'infinite' });
    log('← [JB-17] mode=' + builder.job.metadata.repeat.mode);
    expect(builder.job.metadata.repeat.mode).to.equal('infinite');
  });

  it('[JB-18] withRepeat() without mode defaults to "count"', function() {
    log('→ [JB-18] withRepeat({count:5}) no mode → default "count"');
    var builder = scheduler.create('Math.random').withRepeat({ count: 5 });
    log('← [JB-18] mode=' + builder.job.metadata.repeat.mode);
    expect(builder.job.metadata.repeat.mode).to.equal('count');
  });

});

// ============================================================================
// JB-19: withWeeklySchedule() (pure data)
// ============================================================================

describe('JobBuilder [WEEKLY] — withWeeklySchedule()', function() {

  var scheduler;

  before(function() {
    log('→ [JB-WEEKLY before] new JobScheduler()');
    scheduler = new JobScheduler();
    log('← [JB-WEEKLY before] initialized');
  });

  it('[JB-19] withWeeklySchedule([1,3,5]) sets daysOfWeek', function() {
    log('→ [JB-19] withWeeklySchedule([1,3,5])');
    var builder = scheduler.create('Math.random').withWeeklySchedule([1, 3, 5]);
    log('← [JB-19] daysOfWeek=' + JSON.stringify(builder.job.metadata.weeklySchedule.daysOfWeek));
    expect(builder.job.metadata.weeklySchedule.daysOfWeek).to.deep.equal([1, 3, 5]);
  });

});

// ============================================================================
// JB-20: schedule() with empty steps throws
// ============================================================================

describe('JobBuilder [SCHEDULE] — schedule() validation', function() {

  var scheduler;

  before(function() {
    log('→ [JB-SCHEDULE before] new JobScheduler()');
    scheduler = new JobScheduler();
    log('← [JB-SCHEDULE before] initialized');
  });

  it('[JB-20] schedule() with empty steps array throws before Drive call', function() {
    log('→ [JB-20] create("Math.random") then clear steps → schedule() → expect throw');
    var builder = scheduler.create('Math.random');
    builder.job.steps = [];
    var threw = false;
    try { builder.schedule(); }
    catch (e) { threw = true; log('← [JB-20] threw=' + threw + ' err=' + e.message); }
    expect(threw).to.equal(true);
  });

});
}
__defineModule__(_main);
