function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var LoggerModule = require('then-later/utils/Logger');

var describe = mocha.describe;
var it = mocha.it;
var before = mocha.beforeAll;
var after = mocha.afterAll;
var expect = chai.expect;

var Logger = LoggerModule.Logger;
var LogLevel = LoggerModule.LogLevel;
var getLogLevel = LoggerModule.getLogLevel;
var setLogLevel = LoggerModule.setLogLevel;

var log = function(msg) { Logger.log(msg); };

// Helper: create a Logger whose _log is overridden to track calls
function makeTrackingLogger(level, context) {
  var logger = new Logger(level, context || '');
  logger._calls = [];
  logger._log = function(lvl) { logger._calls.push(lvl); };
  return logger;
}

// ============================================================================
// LGR-01..02: Constructor defaults and explicit
// ============================================================================

describe('Logger [CTOR] — constructor defaults and explicit', function() {

  it('[LGR-01] default constructor creates INFO-level logger with empty context', function() {
    log('→ [LGR-01] new Logger()');
    var logger = new Logger();
    log('← [LGR-01] level=' + logger.level + ' context="' + logger.context + '"');
    expect(logger.level).to.equal(LogLevel.INFO);
    expect(logger.context).to.equal('');
  });

  it('[LGR-02] explicit constructor sets DEBUG level and context string', function() {
    log('→ [LGR-02] new Logger(DEBUG, "TestContext")');
    var logger = new Logger(LogLevel.DEBUG, 'TestContext');
    log('← [LGR-02] level=' + logger.level + ' context=' + logger.context);
    expect(logger.level).to.equal(LogLevel.DEBUG);
    expect(logger.context).to.equal('TestContext');
  });

});

// ============================================================================
// LGR-03..05: Level filtering
// ============================================================================

describe('Logger [FILTER] — level filtering', function() {

  it('[LGR-03] DEBUG level passes all: debug, info, warn, error', function() {
    log('→ [LGR-03] level=DEBUG, call debug/info/warn/error');
    var logger = makeTrackingLogger(LogLevel.DEBUG);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    log('← [LGR-03] calls=' + JSON.stringify(logger._calls));
    expect(logger._calls).to.deep.equal(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('[LGR-04] WARN level suppresses debug and info; passes warn and error', function() {
    log('→ [LGR-04] level=WARN, call debug/info/warn/error');
    var logger = makeTrackingLogger(LogLevel.WARN);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    log('← [LGR-04] calls=' + JSON.stringify(logger._calls));
    expect(logger._calls).to.deep.equal(['WARN', 'ERROR']);
  });

  it('[LGR-05] ERROR level suppresses debug, info, warn; passes only error', function() {
    log('→ [LGR-05] level=ERROR, call debug/info/warn/error');
    var logger = makeTrackingLogger(LogLevel.ERROR);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    log('← [LGR-05] calls=' + JSON.stringify(logger._calls));
    expect(logger._calls).to.deep.equal(['ERROR']);
  });

});

// ============================================================================
// LGR-06..08: child() logger
// ============================================================================

describe('Logger [CHILD] — child logger creation', function() {

  it('[LGR-06] child() creates "parent:sub" context from parent with context', function() {
    log('→ [LGR-06] parent.child("sub") where parent.context="parent"');
    var parent = new Logger(LogLevel.INFO, 'parent');
    var child = parent.child('sub');
    log('← [LGR-06] child.context=' + child.context);
    expect(child.context).to.equal('parent:sub');
  });

  it('[LGR-07] child() with empty parent creates just the sub context', function() {
    log('→ [LGR-07] parent.child("sub") where parent.context=""');
    var parent = new Logger(LogLevel.INFO, '');
    var child = parent.child('sub');
    log('← [LGR-07] child.context=' + child.context);
    expect(child.context).to.equal('sub');
  });

  it('[LGR-08] child() inherits parent log level', function() {
    log('→ [LGR-08] parent DEBUG.child("sub") → child.level?');
    var parent = new Logger(LogLevel.DEBUG, 'parent');
    var child = parent.child('sub');
    log('← [LGR-08] child.level=' + child.level);
    expect(child.level).to.equal(LogLevel.DEBUG);
  });

});

// ============================================================================
// LGR-09: LogLevel constants ordering
// ============================================================================

describe('Logger [CONST] — LogLevel constants ordering', function() {

  it('[LGR-09] DEBUG(0) < INFO(1) < WARN(2) < ERROR(3)', function() {
    log('→ [LGR-09] check LogLevel numeric values');
    log('← [LGR-09] DEBUG=' + LogLevel.DEBUG + ' INFO=' + LogLevel.INFO + ' WARN=' + LogLevel.WARN + ' ERROR=' + LogLevel.ERROR);
    expect(LogLevel.DEBUG).to.equal(0);
    expect(LogLevel.INFO).to.equal(1);
    expect(LogLevel.WARN).to.equal(2);
    expect(LogLevel.ERROR).to.equal(3);
    expect(LogLevel.DEBUG).to.be.lessThan(LogLevel.INFO);
    expect(LogLevel.INFO).to.be.lessThan(LogLevel.WARN);
    expect(LogLevel.WARN).to.be.lessThan(LogLevel.ERROR);
  });

});

// ============================================================================
// LGR-10: setContext()
// ============================================================================

describe('Logger [CTX] — setContext', function() {

  it('[LGR-10] setContext() mutates the context in place', function() {
    log('→ [LGR-10] logger.setContext("updated") from "original"');
    var logger = new Logger(LogLevel.INFO, 'original');
    logger.setContext('updated');
    log('← [LGR-10] context=' + logger.context);
    expect(logger.context).to.equal('updated');
  });

});

// ============================================================================
// LGR-11..13: setLogLevel / getLogLevel (PropertiesService)
// ============================================================================

describe('Logger [PROPS] — setLogLevel / getLogLevel via PropertiesService', function() {

  var _savedLevel;

  before(function() {
    _savedLevel = PropertiesService.getScriptProperties().getProperty('LOG_LEVEL');
    log('→ [LGR-PROPS before] saved LOG_LEVEL=' + _savedLevel);
  });

  after(function() {
    if (_savedLevel !== null) {
      PropertiesService.getScriptProperties().setProperty('LOG_LEVEL', _savedLevel);
    } else {
      PropertiesService.getScriptProperties().deleteProperty('LOG_LEVEL');
    }
    log('← [LGR-PROPS after] restored LOG_LEVEL=' + _savedLevel);
  });

  it('[LGR-11] setLogLevel("DEBUG") causes getLogLevel() to return LogLevel.DEBUG', function() {
    log('→ [LGR-11] setLogLevel("DEBUG")');
    setLogLevel('DEBUG');
    var level = getLogLevel();
    log('← [LGR-11] getLogLevel()=' + level + ' (DEBUG=' + LogLevel.DEBUG + ')');
    expect(level).to.equal(LogLevel.DEBUG);
  });

  it('[LGR-12] unknown LOG_LEVEL value falls back to INFO', function() {
    log('→ [LGR-12] set LOG_LEVEL=NONEXISTENT_LEVEL');
    PropertiesService.getScriptProperties().setProperty('LOG_LEVEL', 'NONEXISTENT_LEVEL');
    var level = getLogLevel();
    log('← [LGR-12] getLogLevel()=' + level + ' (INFO=' + LogLevel.INFO + ')');
    expect(level).to.equal(LogLevel.INFO);
  });

  it('[LGR-13] setLogLevel("WARN") causes getLogLevel() to return LogLevel.WARN', function() {
    log('→ [LGR-13] setLogLevel("WARN")');
    setLogLevel('WARN');
    var level = getLogLevel();
    log('← [LGR-13] getLogLevel()=' + level + ' (WARN=' + LogLevel.WARN + ')');
    expect(level).to.equal(LogLevel.WARN);
  });

});
}
__defineModule__(_main);
