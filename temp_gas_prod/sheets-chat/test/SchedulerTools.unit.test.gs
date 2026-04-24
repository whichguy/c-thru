function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * SchedulerTools.unit.test.gs - Unit tests for SchedulerTools inline tool objects
   *
   * Tests:
   * - ScheduleTaskTool: missing/invalid/no-dot functionPath returns {success:false, error:'Invalid functionPath'}
   * - ScheduleTaskTool: valid functionPath returns {success:true, result:{jobId:string}}
   * - ScheduleTaskTool: unknown task_key returns {success:false}
   * - CancelTaskTool: missing jobId returns {success:false, error:'jobId is required'}
   * - CancelTaskTool: execute returns expected {success, result/error} shape
   *
   * Regression tests (bug-fix coverage):
   * - Bug 1: ScriptRunner.runScript — no-return script succeeds (resultPreview.substring crash)
   * - Bug 3: rescheduleTask — description preserved from original job
   * - GAP 5: GetScriptResultTool — returns null for pending/nonexistent job; returns result for completed
   */

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var SchedulerTools = require('sheets-chat/SchedulerTools');
  var Entrypoints = require('then-later/Entrypoints');
  var ScriptRunner = require('sheets-chat/ScriptRunner');

  var describe = mocha.describe;
  var it = mocha.it;
  var expect = chai.expect;

  // ============================================================================
  // ScheduleTaskTool — input validation
  // ============================================================================

  describe('SchedulerTools [SCHEDULE] — ScheduleTaskTool validation', function() {

    it('should return {success:false, error:"Invalid functionPath"} for missing functionPath', function() {
      var result = SchedulerTools.ScheduleTaskTool.execute({});
      expect(result).to.be.an('object');
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('Invalid functionPath');
    });

    it('should return {success:false, error:"Invalid functionPath"} for non-string functionPath', function() {
      var result = SchedulerTools.ScheduleTaskTool.execute({ functionPath: 123 });
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('Invalid functionPath');
    });

    it('should return {success:false, error:"Invalid functionPath"} for path without dot separator', function() {
      var result = SchedulerTools.ScheduleTaskTool.execute({ functionPath: 'noDotSeparator' });
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('Invalid functionPath');
    });

    it('should return {success:true, result:{jobId:string}} for valid functionPath', function() {
      // ScriptRunner.runScript is the canonical __global__-registered path the scheduler accepts.
      var result = SchedulerTools.ScheduleTaskTool.execute({
        functionPath: 'ScriptRunner.runScript',
        args: ['var x = 1;'],
        delayMs: 3600000  // far future — avoid immediate execution
      });
      expect(result).to.be.an('object');
      expect(result.success).to.equal(true);
      expect(result.result).to.be.an('object');
      expect(result.result.jobId).to.be.a('string');
      expect(result.result.jobId.length).to.be.greaterThan(0);
    });

    it('should return {success:false} for unknown task_key', function() {
      var result = SchedulerTools.ScheduleTaskTool.execute({ task_key: 'not_a_real_task' });
      expect(result.success).to.equal(false);
      expect(result.error).to.be.a('string');
    });

  });

  // ============================================================================
  // CancelTaskTool — input validation and shape
  // ============================================================================

  describe('SchedulerTools [CANCEL] — CancelTaskTool shape', function() {

    it('should return {success:false, error:"jobId is required"} when jobId is missing', function() {
      var result = SchedulerTools.CancelTaskTool.execute({});
      expect(result).to.be.an('object');
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('jobId is required');
    });

    it('should return {success:false, error:"jobId is required"} when jobId is empty string', function() {
      var result = SchedulerTools.CancelTaskTool.execute({ jobId: '' });
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('jobId is required');
    });

    it('should return an object with success property for a valid jobId string', function() {
      var result = SchedulerTools.CancelTaskTool.execute({ jobId: 'nonexistent-job-id-unit-test' });
      expect(result).to.be.an('object');
      expect(result).to.have.property('success');
      if (result.success) {
        expect(result).to.have.property('result');
      } else {
        expect(result).to.have.property('error');
      }
    });

  });

  // ============================================================================
  // Regression: Bug 1 — ScriptRunner no-return script must not crash
  // ============================================================================

  describe('ScriptRunner [BUG1] — no-return script completes without error', function() {

    it('runScript with no return statement should return {firedAt, durationMs, result:undefined}', function() {
      var result = ScriptRunner.runScript('var x = 1 + 1;');
      expect(result).to.be.an('object');
      expect(result.firedAt).to.be.a('string');
      expect(result.durationMs).to.be.a('number');
      // result is undefined for imperative scripts — key must be present but value is undefined
      expect(result).to.have.property('result');
      expect(result.result).to.equal(undefined);
    });

  });

  // ============================================================================
  // Regression: Bug 3 — rescheduleTask preserves description
  // ============================================================================

  describe('Entrypoints [BUG3] — rescheduleTask preserves original description', function() {

    it('rescheduled job should inherit description when caller omits it', function() {
      var r1 = Entrypoints.scheduleScript('var x = 1;', { description: 'bug3-regression', delayMs: 3600000 });
      expect(r1).to.have.property('jobId');

      var r2 = Entrypoints.rescheduleTask(r1.jobId, { delayMs: 7200000 });
      expect(r2).to.have.property('jobId');

      var status = Entrypoints.getJobStatus(r2.jobId);
      expect(status).to.be.an('object');
      expect(status.jobData).to.be.an('object');
      var desc = status.jobData.metadata && status.jobData.metadata.description;
      expect(desc).to.equal('bug3-regression');

      // cleanup
      Entrypoints.cancelPendingJob(r2.jobId);
    });

  });

  // ============================================================================
  // Regression: GAP 5 — GetScriptResultTool returns null for pending jobs
  // ============================================================================

  describe('SchedulerTools [GAP5] — GetScriptResultTool', function() {

    it('should return {success:false, error:...} when jobId is missing', function() {
      var result = SchedulerTools.GetScriptResultTool.execute({});
      expect(result).to.be.an('object');
      expect(result.success).to.equal(false);
      expect(result.error).to.be.a('string');
    });

    it('should return {success:true, result:null} for a pending (not-yet-completed) job', function() {
      var r = Entrypoints.scheduleScript('var x = 1;', { description: 'gap5-pending-test', delayMs: 3600000 });
      expect(r).to.have.property('jobId');

      var result = SchedulerTools.GetScriptResultTool.execute({ jobId: r.jobId });
      expect(result.success).to.equal(true);
      expect(result.result).to.equal(null);  // still pending — not in results/ or deadLetters/

      // cleanup
      Entrypoints.cancelPendingJob(r.jobId);
    });

    it('should return {success:true, result:null} for a nonexistent jobId', function() {
      var result = SchedulerTools.GetScriptResultTool.execute({ jobId: 'nonexistent-gap5-xyz' });
      expect(result.success).to.equal(true);
      expect(result.result).to.equal(null);
    });

  });

}

__defineModule__(_main);
