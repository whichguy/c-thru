function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * UsawStandards.unit.test.gs - Unit tests for USAW Standards pure functions
   *
   * Tests the following functions:
   * - getQualifyingPeriod
   * - calculateSportingAge
   * - getAgeGroup
   * - getStandard
   * - calculatePercentOfA
   * - meetsAStandard / meetsBStandard
   * - parseWeightClassLabel
   * - inferGender
   */

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var UsawStandards = require('tools/helpers/UsawStandards');

  var describe = mocha.describe;
  var it = mocha.it;
  var expect = chai.expect;

  // ============================================================================
  // getQualifyingPeriod Tests
  // ============================================================================

  describe('UsawStandards', function() {

    describe('getQualifyingPeriod', function() {

      it('should return H1 period for January date', function() {
        var result = UsawStandards.getQualifyingPeriod('2026-01-25');

        expect(result.ntpPeriod.half).to.equal('H1');
        expect(result.ntpPeriod.start).to.equal('2026-01-01');
        expect(result.ntpPeriod.end).to.equal('2026-06-30');
        expect(result.start).to.equal('2025-01-01');
        expect(result.end).to.equal('2025-12-31');
        expect(result.standardsYear).to.equal(2025);
      });

      it('should return H1 period for June date', function() {
        var result = UsawStandards.getQualifyingPeriod('2026-06-15');

        expect(result.ntpPeriod.half).to.equal('H1');
        expect(result.standardsYear).to.equal(2025);
      });

      it('should return H2 period for July date', function() {
        var result = UsawStandards.getQualifyingPeriod('2026-07-01');

        expect(result.ntpPeriod.half).to.equal('H2');
        expect(result.ntpPeriod.start).to.equal('2026-07-01');
        expect(result.ntpPeriod.end).to.equal('2026-12-31');
        expect(result.start).to.equal('2025-07-01');
        expect(result.end).to.equal('2026-06-30');
        expect(result.standardsYear).to.equal(2026);
      });

      it('should return H2 period for December date', function() {
        var result = UsawStandards.getQualifyingPeriod('2025-12-15');

        expect(result.ntpPeriod.half).to.equal('H2');
        expect(result.standardsYear).to.equal(2025);
      });

      it('should handle Date object input', function() {
        var result = UsawStandards.getQualifyingPeriod(new Date(2026, 0, 15)); // January

        expect(result.ntpPeriod.half).to.equal('H1');
      });

      it('should default to current date when no input provided', function() {
        var result = UsawStandards.getQualifyingPeriod();

        expect(result).to.have.property('ntpPeriod');
        expect(result).to.have.property('start');
        expect(result).to.have.property('end');
        expect(result).to.have.property('standardsYear');
      });

    });

    // ============================================================================
    // calculateSportingAge Tests
    // ============================================================================

    describe('calculateSportingAge', function() {

      it('should calculate age based on birth year and NTP period', function() {
        var age = UsawStandards.calculateSportingAge(2000, '2026-01-01');
        expect(age).to.equal(26);
      });

      it('should return 0 for same year', function() {
        var age = UsawStandards.calculateSportingAge(2026, '2026-01-01');
        expect(age).to.equal(0);
      });

      it('should handle young athletes', function() {
        var age = UsawStandards.calculateSportingAge(2012, '2026-01-01');
        expect(age).to.equal(14);
      });

    });

    // ============================================================================
    // getAgeGroup Tests
    // ============================================================================

    describe('getAgeGroup', function() {

      it('should return U15 for age 14 and under', function() {
        expect(UsawStandards.getAgeGroup(10)).to.equal('U15');
        expect(UsawStandards.getAgeGroup(13)).to.equal('U15');
        expect(UsawStandards.getAgeGroup(14)).to.equal('U15');
      });

      it('should return Youth for ages 15-17', function() {
        expect(UsawStandards.getAgeGroup(15)).to.equal('Youth');
        expect(UsawStandards.getAgeGroup(16)).to.equal('Youth');
        expect(UsawStandards.getAgeGroup(17)).to.equal('Youth');
      });

      it('should return Junior for ages 18-20', function() {
        expect(UsawStandards.getAgeGroup(18)).to.equal('Junior');
        expect(UsawStandards.getAgeGroup(19)).to.equal('Junior');
        expect(UsawStandards.getAgeGroup(20)).to.equal('Junior');
      });

      it('should return Senior for ages 21+', function() {
        expect(UsawStandards.getAgeGroup(21)).to.equal('Senior');
        expect(UsawStandards.getAgeGroup(30)).to.equal('Senior');
        expect(UsawStandards.getAgeGroup(45)).to.equal('Senior');
      });

    });

    // ============================================================================
    // getStandard Tests
    // ============================================================================

    describe('getStandard', function() {

      it('should return Senior Men 65kg standards for 2025', function() {
        var std = UsawStandards.getStandard(2025, 'Senior', 'M', 65);

        expect(std).to.have.property('a', 304);
        expect(std).to.have.property('b', 289);
      });

      it('should return Senior Women 58kg standards for 2025', function() {
        var std = UsawStandards.getStandard(2025, 'Senior', 'F', 58);

        expect(std).to.have.property('a', 215);
        expect(std).to.have.property('b', 204);
      });

      it('should handle superheavy weight class as string', function() {
        var std = UsawStandards.getStandard(2025, 'Senior', 'M', '+110');

        expect(std).to.have.property('a', 410);
        expect(std).to.have.property('b', 390);
      });

      it('should return Junior standards', function() {
        var std = UsawStandards.getStandard(2025, 'Junior', 'M', 71);

        expect(std).to.have.property('a', 293);
        expect(std).to.have.property('b', 276);
      });

      it('should return Youth standards', function() {
        var std = UsawStandards.getStandard(2025, 'Youth', 'F', 53);

        expect(std).to.have.property('a', 159);
        expect(std).to.have.property('b', 149);
      });

      it('should return U15 standards (single standard, no B)', function() {
        var std = UsawStandards.getStandard(2025, 'U15', 'M', 56);

        expect(std).to.have.property('a', 181);
        expect(std).to.not.have.property('b');
      });

      it('should return null for invalid year', function() {
        var std = UsawStandards.getStandard(2020, 'Senior', 'M', 65);
        expect(std).to.be.null;
      });

      it('should return null for invalid age group', function() {
        var std = UsawStandards.getStandard(2025, 'Masters', 'M', 65);
        expect(std).to.be.null;
      });

      it('should return null for invalid weight class', function() {
        var std = UsawStandards.getStandard(2025, 'Senior', 'M', 999);
        expect(std).to.be.null;
      });

    });

    // ============================================================================
    // calculatePercentOfA Tests
    // ============================================================================

    describe('calculatePercentOfA', function() {

      it('should calculate exact 100% correctly', function() {
        var pct = UsawStandards.calculatePercentOfA(304, 304);
        expect(pct).to.equal(100);
      });

      it('should calculate above 100% correctly', function() {
        var pct = UsawStandards.calculatePercentOfA(320, 304);
        expect(pct).to.be.greaterThan(100);
      });

      it('should calculate below 100% correctly', function() {
        var pct = UsawStandards.calculatePercentOfA(280, 304);
        expect(pct).to.be.lessThan(100);
      });

      it('should return 0 for zero standard', function() {
        var pct = UsawStandards.calculatePercentOfA(280, 0);
        expect(pct).to.equal(0);
      });

      it('should return 0 for null standard', function() {
        var pct = UsawStandards.calculatePercentOfA(280, null);
        expect(pct).to.equal(0);
      });

      it('should round to 3 decimal places', function() {
        var pct = UsawStandards.calculatePercentOfA(289, 304);
        // 289/304 = 0.95065789... -> 95.066
        expect(String(pct).split('.')[1].length).to.be.lte(3);
      });

    });

    // ============================================================================
    // meetsAStandard / meetsBStandard Tests
    // ============================================================================

    describe('meetsAStandard', function() {

      it('should return true when total equals A standard', function() {
        expect(UsawStandards.meetsAStandard(304, 304)).to.be.true;
      });

      it('should return true when total exceeds A standard', function() {
        expect(UsawStandards.meetsAStandard(320, 304)).to.be.true;
      });

      it('should return false when total is below A standard', function() {
        expect(UsawStandards.meetsAStandard(280, 304)).to.be.false;
      });

    });

    describe('meetsBStandard', function() {

      it('should return true when total equals B standard', function() {
        expect(UsawStandards.meetsBStandard(289, 289)).to.be.true;
      });

      it('should return true when total exceeds B standard', function() {
        expect(UsawStandards.meetsBStandard(300, 289)).to.be.true;
      });

      it('should return false when total is below B standard', function() {
        expect(UsawStandards.meetsBStandard(280, 289)).to.be.false;
      });

    });

    // ============================================================================
    // parseWeightClassLabel Tests
    // ============================================================================

    describe('parseWeightClassLabel', function() {

      it('should parse standard Senior weight class', function() {
        var result = UsawStandards.parseWeightClassLabel("Men's 65kg");

        expect(result.cat).to.equal('Open');
        expect(result.kg).to.equal(65);
        expect(result.isMasters).to.be.false;
      });

      it('should parse Youth weight class', function() {
        var result = UsawStandards.parseWeightClassLabel("Women's Youth 58kg");

        expect(result.cat).to.equal('Youth');
        expect(result.kg).to.equal(58);
      });

      it('should parse Junior weight class', function() {
        var result = UsawStandards.parseWeightClassLabel("Men's Junior 79kg");

        expect(result.cat).to.equal('Junior');
        expect(result.kg).to.equal(79);
      });

      it('should parse U15 weight class', function() {
        var result = UsawStandards.parseWeightClassLabel("Men's U15 65kg");

        expect(result.cat).to.equal('U15');
        expect(result.kg).to.equal(65);
      });

      it('should parse U11/U13 as U15', function() {
        var r1 = UsawStandards.parseWeightClassLabel("Women's U11 44kg");
        var r2 = UsawStandards.parseWeightClassLabel("Men's U13 56kg");

        expect(r1.cat).to.equal('U15');
        expect(r2.cat).to.equal('U15');
      });

      it('should parse "13 Under Age Group" as U15', function() {
        var result = UsawStandards.parseWeightClassLabel("Women's 13 Under Age Group 53kg");

        expect(result.cat).to.equal('U15');
        expect(result.kg).to.equal(53);
      });

      it('should parse age range 14-15 as Youth', function() {
        var result = UsawStandards.parseWeightClassLabel("Women's 14-15 58kg");

        expect(result.cat).to.equal('Youth');
        expect(result.ageRange).to.equal('14-15');
      });

      it('should parse age range 16-17 as Youth', function() {
        var result = UsawStandards.parseWeightClassLabel("Men's 16-17 71kg");

        expect(result.cat).to.equal('Youth');
        expect(result.ageRange).to.equal('16-17');
      });

      it('should parse age range 18-20 as Junior', function() {
        var result = UsawStandards.parseWeightClassLabel("Women's 18-20 63kg");

        expect(result.cat).to.equal('Junior');
        expect(result.ageRange).to.equal('18-20');
      });

      it('should parse superheavy with plus prefix', function() {
        var result = UsawStandards.parseWeightClassLabel("Men's +110kg");

        expect(result.kg).to.equal('+110');
      });

      it('should parse superheavy with plus suffix', function() {
        var result = UsawStandards.parseWeightClassLabel("Women's 86+kg");

        expect(result.kg).to.equal('+86');
      });

      it('should detect Masters category', function() {
        var result = UsawStandards.parseWeightClassLabel("Men's Masters 81kg");

        expect(result.isMasters).to.be.true;
      });

      it('should handle null input', function() {
        var result = UsawStandards.parseWeightClassLabel(null);

        expect(result.cat).to.equal('Open');
        expect(result.kg).to.be.null;
      });

      it('should handle empty string', function() {
        var result = UsawStandards.parseWeightClassLabel('');

        expect(result.cat).to.equal('Open');
        expect(result.kg).to.be.null;
      });

    });

    // ============================================================================
    // inferGender Tests
    // ============================================================================

    describe('inferGender', function() {

      it('should detect Women from label', function() {
        expect(UsawStandards.inferGender("Women's 58kg")).to.equal('F');
      });

      it('should detect Men from label', function() {
        expect(UsawStandards.inferGender("Men's 65kg")).to.equal('M');
      });

      it('should detect Female keyword', function() {
        expect(UsawStandards.inferGender("Female Youth 53kg")).to.equal('F');
      });

      it('should detect Male keyword', function() {
        expect(UsawStandards.inferGender("Male Junior 71kg")).to.equal('M');
      });

      it('should infer Women from light weight class', function() {
        expect(UsawStandards.inferGender("48kg")).to.equal('F');
      });

      it('should infer Men from heavy weight class', function() {
        expect(UsawStandards.inferGender("94kg")).to.equal('M');
      });

      it('should default to Men for ambiguous input', function() {
        expect(UsawStandards.inferGender("71kg")).to.equal('M');
      });

      it('should default to Men for null input', function() {
        expect(UsawStandards.inferGender(null)).to.equal('M');
      });

    });

    // ============================================================================
    // isWithinQualifyingPeriod Tests
    // ============================================================================

    describe('isWithinQualifyingPeriod', function() {

      it('should return true for date within period', function() {
        var period = { start: '2025-01-01', end: '2025-12-31' };
        var result = UsawStandards.isWithinQualifyingPeriod('2025-06-15', period);

        expect(result).to.be.true;
      });

      it('should return true for date at start of period', function() {
        var period = { start: '2025-01-01', end: '2025-12-31' };
        var result = UsawStandards.isWithinQualifyingPeriod('2025-01-01', period);

        expect(result).to.be.true;
      });

      it('should return true for date at end of period', function() {
        var period = { start: '2025-01-01', end: '2025-12-31' };
        var result = UsawStandards.isWithinQualifyingPeriod('2025-12-31', period);

        expect(result).to.be.true;
      });

      it('should return false for date before period', function() {
        var period = { start: '2025-01-01', end: '2025-12-31' };
        var result = UsawStandards.isWithinQualifyingPeriod('2024-12-31', period);

        expect(result).to.be.false;
      });

      it('should return false for date after period', function() {
        var period = { start: '2025-01-01', end: '2025-12-31' };
        var result = UsawStandards.isWithinQualifyingPeriod('2026-01-01', period);

        expect(result).to.be.false;
      });

    });

    // ============================================================================
    // meetsPerformanceImprovement Tests
    // ============================================================================

    describe('meetsPerformanceImprovement', function() {

      it('should return true for exactly 1% improvement', function() {
        // 100 + 1% = 101
        var result = UsawStandards.meetsPerformanceImprovement(100, 101);
        expect(result).to.be.true;
      });

      it('should return true for more than 1% improvement', function() {
        var result = UsawStandards.meetsPerformanceImprovement(100, 105);
        expect(result).to.be.true;
      });

      it('should return false for less than 1% improvement', function() {
        var result = UsawStandards.meetsPerformanceImprovement(100, 100);
        expect(result).to.be.false;
      });

      it('should handle realistic totals', function() {
        // 300kg + 1% = 303kg (rounded)
        var result = UsawStandards.meetsPerformanceImprovement(300, 303);
        expect(result).to.be.true;

        var result2 = UsawStandards.meetsPerformanceImprovement(300, 302);
        expect(result2).to.be.false;
      });

    });

  });
}

__defineModule__(_main, false);