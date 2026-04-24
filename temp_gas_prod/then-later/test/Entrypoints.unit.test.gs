/**
 * Entrypoints.unit.test.gs - Unit tests for Entrypoints helper functions
 *
 * Tests (ScriptProperties-only, no Drive):
 * - cancelTriggerById: sets cancel_* key, idempotent on second call
 * - isCancelRequested outside trigger: returns false (no active _globalContext)
 * - timeRemaining outside trigger: returns null (no active _globalContext)
 * - rescheduleCurrentJobIfNeed outside trigger: throws Error containing "No active trigger"
 * - installWatchdogTrigger idempotent: second call does not create a duplicate trigger
 */

function _main(module, exports, log) {

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var Entrypoints = require('then-later/Entrypoints');

  var describe = mocha.describe;
  var it = mocha.it;
  var expect = chai.expect;

  // ============================================================================
  // Tests
  // ============================================================================

  describe('Entrypoints [CANCEL] — cancelTriggerById', function() {

    it('should set cancel_* key in ScriptProperties to a truthy value', function() {
      var triggerId = 'test-ep-trig-xxx';
      try {
        Entrypoints.cancelTriggerById(triggerId);
        var val = PropertiesService.getScriptProperties().getProperty('cancel_' + triggerId);
        expect(val).to.not.equal(null);
      } finally {
        PropertiesService.getScriptProperties().deleteProperty('cancel_' + triggerId);
      }
    });

    it('second call is idempotent (does not throw)', function() {
      var triggerId = 'test-ep-trig-xxx';
      try {
        Entrypoints.cancelTriggerById(triggerId);
        var threw = false;
        try {
          Entrypoints.cancelTriggerById(triggerId);
        } catch (e) {
          threw = true;
        }
        expect(threw).to.equal(false);
      } finally {
        PropertiesService.getScriptProperties().deleteProperty('cancel_' + triggerId);
      }
    });

  });

  describe('Entrypoints [STATE] — isCancelRequested outside trigger', function() {

    it('should return false when no active trigger context exists', function() {
      var result = Entrypoints.isCancelRequested();
      expect(result).to.equal(false);
    });

  });

  describe('Entrypoints [STATE] — timeRemaining outside trigger', function() {

    it('should return null when no active trigger context exists', function() {
      var result = Entrypoints.timeRemaining();
      expect(result).to.equal(null);
    });

  });

  describe('Entrypoints [RESCHED] — rescheduleCurrentJobIfNeed outside trigger', function() {

    it('should throw an error containing "No active trigger"', function() {
      var threw = false;
      var errorMessage = '';
      try {
        Entrypoints.rescheduleCurrentJobIfNeed(null);
      } catch (e) {
        threw = true;
        errorMessage = e.message || '';
      }
      expect(threw).to.equal(true);
      expect(errorMessage.toLowerCase()).to.include('no active trigger');
    });

  });

  describe('Entrypoints [SCHEDULE] — scheduleTask', function() {

    it('should return an object with a string jobId property', function() {
      var result = Entrypoints.scheduleTask('then-later/Entrypoints.getJobCounts', [], 0);
      expect(result).to.be.an('object');
      expect(result).to.have.property('jobId');
      expect(result.jobId).to.be.a('string');
      expect(result.jobId.length).to.be.greaterThan(0);
    });

    it('calling with valid functionPath should not throw synchronously', function() {
      var threw = false;
      try {
        Entrypoints.scheduleTask('then-later/Entrypoints.getJobCounts', [], 0);
      } catch (e) {
        threw = true;
      }
      expect(threw).to.equal(false);
    });

  });

  describe('Entrypoints [COUNTS] — getJobCounts', function() {

    it('should return an object with pending, running, completed, failed as non-negative numbers', function() {
      log('→ [EP-COUNTS-01] getJobCounts()');
      var counts = Entrypoints.getJobCounts();
      log('← [EP-COUNTS-01] counts=' + JSON.stringify(counts));
      expect(counts).to.be.an('object');
      expect(counts.pending).to.be.a('number');
      expect(counts.running).to.be.a('number');
      expect(counts.completed).to.be.a('number');
      expect(counts.failed).to.be.a('number');
      expect(counts.pending).to.be.greaterThan(-1);
      expect(counts.running).to.be.greaterThan(-1);
      expect(counts.completed).to.be.greaterThan(-1);
      expect(counts.failed).to.be.greaterThan(-1);
    });

  });

  describe('Entrypoints [RESULTS] — listScriptResults', function() {

    it('should return an array (empty or populated)', function() {
      log('→ [EP-RESULTS-01] listScriptResults()');
      var results = Entrypoints.listScriptResults();
      log('← [EP-RESULTS-01] results.length=' + results.length);
      expect(results).to.be.an('array');
    });

    it('each entry should have jobId, description, status properties', function() {
      log('→ [EP-RESULTS-02] listScriptResults() entry shape');
      var results = Entrypoints.listScriptResults();
      if (results.length === 0) {
        log('← [EP-RESULTS-02] no results — skipping shape assertions');
        return;
      }
      var entry = results[0];
      expect(entry).to.have.property('jobId');
      expect(entry).to.have.property('description');
      expect(entry).to.have.property('status');
      expect(entry.jobId).to.be.a('string');
      expect(entry.status).to.be.oneOf(['completed', 'failed']);
      log('← [EP-RESULTS-02] entry.status=' + entry.status + ' jobId=' + entry.jobId);
    });

    it('pending job should not appear in listScriptResults (not yet in results/ folder)', function() {
      log('→ [EP-RESULTS-03] listScriptResults filters pending jobs');
      var before = Entrypoints.listScriptResults().length;
      var r = Entrypoints.scheduleScript('var _placeholder = 1;', {
        description: 'ep-results-03-regression',
        delayMs: 3600000
      });
      expect(r).to.have.property('jobId');
      var after = Entrypoints.listScriptResults().length;
      expect(after).to.equal(before);
      log('← [EP-RESULTS-03] before=' + before + ' after=' + after + ' (unchanged)');
      try { Entrypoints.cancelPendingJob(r.jobId); } catch (e) {}
    });

  });

  describe('Entrypoints [WDOG] — installWatchdogTrigger idempotent', function() {

    it('should not create a duplicate watchdog trigger on second call', function() {
      // ScriptApp.getProjectTriggers() requires the script.scriptapp OAuth scope which is not
      // available in the web app exec context. Skip the trigger-count assertions when unavailable.
      var scriptAppAvailable = true;
      try { ScriptApp.getProjectTriggers(); } catch (e) { scriptAppAvailable = false; }

      if (!scriptAppAvailable) {
        // In exec context: verify that installWatchdogTrigger itself handles the permission
        // error gracefully (Drive initialization still works, trigger creation attempt does not throw)
        var threw = false;
        try {
          Entrypoints.installWatchdogTrigger();
        } catch (e) {
          // Only fail if it's not a ScriptApp permission error
          if (e.message && e.message.indexOf('ScriptApp') < 0 &&
              e.message.indexOf('permission') < 0) {
            threw = true;
          }
        }
        expect(threw).to.equal(false);
        return;
      }

      // Full idempotency check when ScriptApp is available (e.g., real trigger context)
      ScriptApp.getProjectTriggers().forEach(function(t) {
        if (t.getHandlerFunction() === 'watchdogCleanup') ScriptApp.deleteTrigger(t);
      });

      try {
        Entrypoints.installWatchdogTrigger();

        var countAfterFirst = ScriptApp.getProjectTriggers().filter(function(t) {
          return t.getHandlerFunction() === 'watchdogCleanup';
        }).length;

        Entrypoints.installWatchdogTrigger();

        var countAfterSecond = ScriptApp.getProjectTriggers().filter(function(t) {
          return t.getHandlerFunction() === 'watchdogCleanup';
        }).length;

        expect(countAfterFirst).to.equal(1);
        expect(countAfterSecond).to.equal(1);
      } finally {
        try {
          ScriptApp.getProjectTriggers().forEach(function(t) {
            if (t.getHandlerFunction() === 'watchdogCleanup') ScriptApp.deleteTrigger(t);
          });
        } catch (e) {}
      }
    });

  });

}

__defineModule__(_main);
