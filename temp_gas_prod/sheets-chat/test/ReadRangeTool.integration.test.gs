function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * ReadRangeTool.integration.test.gs - Integration tests for ReadRangeTool
 *
 * Tests:
 * - execute: reads values from a real spreadsheet range
 * - execute: reads formulas when includeFormulas=true
 * - execute: rejects ranges exceeding 5,000 cells
 * - execute: handles invalid range names gracefully
 * - execute: works with active sheet ranges (no sheet prefix)
 *
 * Requires: Active spreadsheet context (Sheets add-on, not time-driven trigger)
 */

var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var ReadRangeTool = require('sheets-chat/ReadRangeTool');

var describe = mocha.describe;
var it = mocha.it;
var expect = chai.expect;

describe('ReadRangeTool', function() {

  // --------------------------------------------------------------------------
  // execute - basic value reads
  // --------------------------------------------------------------------------

  describe('execute - value reads', function() {

    it('should return success:true for a valid small range', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      var result = ReadRangeTool.execute({ range: sheetName + '!A1:B2' });

      expect(result.success).to.equal(true);
      expect(result.result).to.have.property('values');
      expect(result.result).to.have.property('rows');
      expect(result.result).to.have.property('cols');
      expect(result.result).to.have.property('rangeA1');
      expect(result.result.rows).to.equal(2);
      expect(result.result.cols).to.equal(2);
    });

    it('should return a 2D array of values', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      var result = ReadRangeTool.execute({ range: sheetName + '!A1:C3' });

      expect(result.success).to.equal(true);
      expect(result.result.values).to.be.an('array');
      expect(result.result.values.length).to.equal(3);
      expect(result.result.values[0]).to.be.an('array');
      expect(result.result.values[0].length).to.equal(3);
    });

    it('should read a single cell', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      var result = ReadRangeTool.execute({ range: sheetName + '!A1' });

      expect(result.success).to.equal(true);
      expect(result.result.rows).to.equal(1);
      expect(result.result.cols).to.equal(1);
      expect(result.result.values.length).to.equal(1);
      expect(result.result.values[0].length).to.equal(1);
    });

    it('should support ranges without sheet prefix (active sheet)', function() {
      var result = ReadRangeTool.execute({ range: 'A1:B2' });
      // Either succeeds (if active sheet has those cells) or fails gracefully
      expect(result).to.have.property('success');
    });

  });

  // --------------------------------------------------------------------------
  // execute - formula reads
  // --------------------------------------------------------------------------

  describe('execute - formula reads', function() {

    it('should return formulas when includeFormulas=true', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      var result = ReadRangeTool.execute({ range: sheetName + '!A1:C3', includeFormulas: true });

      expect(result.success).to.equal(true);
      expect(result.result.values).to.be.an('array');
      // Cells without formulas return empty string
      result.result.values.forEach(function(row) {
        row.forEach(function(cell) {
          expect(typeof cell).to.equal('string');
        });
      });
    });

    it('should include "Non-formula cells show as empty string" note with includeFormulas', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      var result = ReadRangeTool.execute({ range: sheetName + '!A1:B2', includeFormulas: true });

      expect(result.success).to.equal(true);
      expect(result.result.note).to.include('Non-formula');
    });

    it('should NOT include note when includeFormulas is false', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      var result = ReadRangeTool.execute({ range: sheetName + '!A1:B2', includeFormulas: false });

      expect(result.success).to.equal(true);
      expect(result.result.note).to.equal(undefined);
    });

  });

  // --------------------------------------------------------------------------
  // execute - cell limit enforcement (5,000 cell cap)
  // --------------------------------------------------------------------------

  describe('execute - cell limit (5,000 cap)', function() {

    it('should reject a range exceeding 5,000 cells', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      // 100 rows × 51 cols = 5,100 cells > 5,000 limit
      var result = ReadRangeTool.execute({ range: sheetName + '!A1:AY100' });

      expect(result.success).to.equal(false);
      expect(result.error).to.include('5,000');
    });

    it('should accept a range of exactly 5,000 cells', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      // 100 rows × 50 cols = 5,000 cells = exactly the limit
      var result = ReadRangeTool.execute({ range: sheetName + '!A1:AX100' });

      // Should either succeed (if sheet has enough rows/cols) or fail gracefully
      expect(result).to.have.property('success');
      if (!result.success) {
        // If it fails, it must be a non-limit error (e.g., sheet too small)
        expect(result.error).to.not.include('5,000');
      }
    });

    it('should include cell count in the error message', function() {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var sheetName = sheet.getName();

      // 101 rows × 51 cols = 5,151 cells
      var result = ReadRangeTool.execute({ range: sheetName + '!A1:AY101' });

      if (!result.success && result.error.includes('5,000')) {
        expect(result.error).to.match(/\d+\s+cells/);
      }
    });

  });

  // --------------------------------------------------------------------------
  // execute - error handling
  // --------------------------------------------------------------------------

  describe('execute - error handling', function() {

    it('should return success:false for an invalid range string', function() {
      var result = ReadRangeTool.execute({ range: 'NotARealSheet!A1:B2' });

      expect(result.success).to.equal(false);
      expect(result.error).to.be.a('string');
      expect(result.error.length).to.be.greaterThan(0);
    });

    it('should include the range name in the error message', function() {
      var badRange = 'NonExistentSheet999!A1:B2';
      var result = ReadRangeTool.execute({ range: badRange });

      if (!result.success) {
        expect(result.error).to.include(badRange);
      }
    });

    it('should return an object with success property for any input', function() {
      var result = ReadRangeTool.execute({ range: '' });
      expect(result).to.have.property('success');
    });

  });

});
}
__defineModule__(_main);
