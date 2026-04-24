/**
 * JobExecutor.unit.test.gs - Unit tests for JobExecutor function resolution and execution
 *
 * Tests:
 * - resolveFunction security: rejects empty paths, spaces, blocked terms, missing props, non-functions
 * - resolveFunction legitimate names: resolves names containing blocked substrings (no false-positive)
 * - executeStep: returns result for Math.random, throws JobExecutionError for bad path, generic Error
 *   for missing functionPath
 * - validateFunctionPath: passes Math.random, throws FunctionPathError for "foo bar"
 */

function _main(module, exports, log) {

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var JobExecutorModule = require('then-later/core/JobExecutor');

  var describe = mocha.describe;
  var it = mocha.it;
  var expect = chai.expect;

  var JobExecutor = JobExecutorModule.JobExecutor;
  var FunctionPathError = JobExecutorModule.FunctionPathError;
  var JobExecutionError = JobExecutorModule.JobExecutionError;

  // ============================================================================
  // Helper
  // ============================================================================

  /**
   * Assert that calling fn() throws a FunctionPathError.
   */
  function expectFunctionPathError(fn) {
    var threw = false;
    var errorName = null;
    try {
      fn();
    } catch (e) {
      threw = true;
      errorName = e.name;
    }
    expect(threw).to.equal(true);
    expect(errorName).to.equal('FunctionPathError');
  }

  // ============================================================================
  // Tests
  // ============================================================================

  describe('JobExecutor [SEC] — resolveFunction security', function() {

    it('should resolve Math.random to a function', function() {
      log('→ [JE-SEC-01] resolveFunction("Math.random")');
      var executor = new JobExecutor();
      var fn = executor.resolveFunction('Math.random');
      log('← [JE-SEC-01] typeof fn=' + typeof fn);
      expect(fn).to.be.a('function');
    });

    it('should resolve Math.max to a function', function() {
      log('→ [JE-SEC-02] resolveFunction("Math.max")');
      var executor = new JobExecutor();
      var fn = executor.resolveFunction('Math.max');
      log('← [JE-SEC-02] typeof fn=' + typeof fn);
      expect(fn).to.be.a('function');
    });

    it('empty string should throw FunctionPathError', function() {
      log('→ [JE-SEC-03] resolveFunction("") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction(''); });
      log('← [JE-SEC-03] FunctionPathError confirmed');
    });

    it('path with space "foo bar" should throw FunctionPathError', function() {
      log('→ [JE-SEC-04] resolveFunction("foo bar") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction('foo bar'); });
      log('← [JE-SEC-04] FunctionPathError confirmed');
    });

    it('path segment "constructor" should throw FunctionPathError', function() {
      log('→ [JE-SEC-05] resolveFunction("constructor") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction('constructor'); });
      log('← [JE-SEC-05] FunctionPathError confirmed');
    });

    it('path segment "__proto__" should throw FunctionPathError', function() {
      log('→ [JE-SEC-06] resolveFunction("__proto__") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction('__proto__'); });
      log('← [JE-SEC-06] FunctionPathError confirmed');
    });

    it('path segment "eval" should throw FunctionPathError', function() {
      log('→ [JE-SEC-07] resolveFunction("eval") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction('eval'); });
      log('← [JE-SEC-07] FunctionPathError confirmed');
    });

    it('path to undefined property nonExistentXyz123 should throw FunctionPathError', function() {
      log('→ [JE-SEC-08] resolveFunction("nonExistentXyz123") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction('nonExistentXyz123'); });
      log('← [JE-SEC-08] FunctionPathError confirmed');
    });

    it('path to non-function Math.PI should throw FunctionPathError', function() {
      log('→ [JE-SEC-09] resolveFunction("Math.PI") → expect FunctionPathError (not a function)');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.resolveFunction('Math.PI'); });
      log('← [JE-SEC-09] FunctionPathError confirmed');
    });

  });

  describe('JobExecutor [LEGIT] — resolveFunction legitimate names', function() {

    it('bindDataHelper on globalThis resolves (no substring false-positive for "bind")', function() {
      globalThis.bindDataHelper = function() {};
      log('→ [JE-LEGIT-01] resolveFunction("bindDataHelper") — should NOT be blocked by "bind" check');
      try {
        var executor = new JobExecutor();
        var fn = executor.resolveFunction('bindDataHelper');
        log('← [JE-LEGIT-01] typeof fn=' + typeof fn);
        expect(fn).to.be.a('function');
      } finally {
        delete globalThis.bindDataHelper;
      }
    });

    it('callbackResult on globalThis resolves (no substring false-positive for "call")', function() {
      globalThis.callbackResult = function() {};
      log('→ [JE-LEGIT-02] resolveFunction("callbackResult") — should NOT be blocked by "call" check');
      try {
        var executor = new JobExecutor();
        var fn = executor.resolveFunction('callbackResult');
        log('← [JE-LEGIT-02] typeof fn=' + typeof fn);
        expect(fn).to.be.a('function');
      } finally {
        delete globalThis.callbackResult;
      }
    });

  });

  describe('JobExecutor [EXEC] — executeStep', function() {

    it('step with functionPath Math.random and empty parameters returns a number', function() {
      log('→ [JE-EXEC-01] executeStep({functionPath:"Math.random", parameters:[]})');
      var executor = new JobExecutor();
      var result = executor.executeStep({ functionPath: 'Math.random', parameters: [] }, null, {});
      log('← [JE-EXEC-01] result=' + result + ' typeof=' + typeof result);
      expect(result).to.be.a('number');
    });

    it('step with nonExistentFunctionXYZ throws JobExecutionError', function() {
      log('→ [JE-EXEC-02] executeStep({functionPath:"nonExistentFunctionXYZ"}) → expect JobExecutionError');
      var executor = new JobExecutor();
      var threw = false;
      var errorName = null;
      try {
        executor.executeStep({ functionPath: 'nonExistentFunctionXYZ', parameters: [] }, null, {});
      } catch (e) {
        threw = true;
        errorName = e.name;
      }
      log('← [JE-EXEC-02] threw=' + threw + ' name=' + errorName);
      expect(threw).to.equal(true);
      expect(errorName).to.equal('JobExecutionError');
    });

    it('step with missing functionPath property throws generic Error', function() {
      log('→ [JE-EXEC-03] executeStep({}) missing functionPath → expect throw');
      var executor = new JobExecutor();
      var threw = false;
      try {
        executor.executeStep({}, null, {});
      } catch (e) {
        threw = true;
        log('← [JE-EXEC-03] threw=' + threw + ' name=' + e.name);
      }
      expect(threw).to.equal(true);
    });

  });

  describe('JobExecutor [VALID] — validateFunctionPath', function() {

    it('Math.random should not throw', function() {
      log('→ [JE-VALID-01] validateFunctionPath("Math.random") → no throw');
      var executor = new JobExecutor();
      var threw = false;
      try {
        executor.validateFunctionPath('Math.random');
      } catch (e) {
        threw = true;
        log('← [JE-VALID-01] unexpected throw: ' + e.message);
      }
      log('← [JE-VALID-01] threw=' + threw);
      expect(threw).to.equal(false);
    });

    it('"foo bar" should throw FunctionPathError', function() {
      log('→ [JE-VALID-02] validateFunctionPath("foo bar") → expect FunctionPathError');
      var executor = new JobExecutor();
      expectFunctionPathError(function() { executor.validateFunctionPath('foo bar'); });
      log('← [JE-VALID-02] FunctionPathError confirmed');
    });

  });

}

__defineModule__(_main);
