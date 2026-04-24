function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * NtpSelection.integration.test.gs - Integration tests for NTP tier assignment
   *
   * Uses fixture data representing real athlete performances to verify
   * the complete NTP selection logic including tier assignments.
   *
   * Test Date: 2026-01-25 (H1 period)
   * Qualifying Period: 2025-01-01 to 2025-12-31
   * Standards Year: 2025
   */

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var UsawStandards = require('tools/helpers/UsawStandards');

  var describe = mocha.describe;
  var it = mocha.it;
  var beforeEach = mocha.beforeEach;
  var expect = chai.expect;

  // ============================================================================
  // TEST FIXTURES
  // ============================================================================

  /**
   * Fixture athletes representing different NTP tier scenarios
   * Based on 2025 standards and H1 2026 qualifying period
   */
  var FIXTURES = {

    // Gold tier candidates: International + Senior A standard
    goldMen: [
      {
        name: 'CJ Cummings',
        athleteId: 'gold-m-1',
        gender: 'M',
        weightClass: 79,
        total: 360,  // Above Senior A (347)
        date: '2025-03-15',
        eventLevel: 4,  // International
        level: 'International',
        birthYear: 1999,
        eventName: 'Pan American Championships'
      },
      {
        name: 'Wes Kitts',
        athleteId: 'gold-m-2',
        gender: 'M',
        weightClass: 110,
        total: 400,  // Above Senior A (388)
        date: '2025-05-20',
        eventLevel: 4,
        level: 'International',
        birthYear: 1990,
        eventName: 'World Championships'
      }
    ],

    goldWomen: [
      {
        name: 'Kate Nye',
        athleteId: 'gold-f-1',
        gender: 'F',
        weightClass: 69,
        total: 245,  // Above Senior A (233)
        date: '2025-04-10',
        eventLevel: 4,
        level: 'International',
        birthYear: 1999,
        eventName: 'World Championships'
      }
    ],

    // Silver tier: International + Senior B (or A but not top 6)
    silverMen: [
      {
        name: 'Silver Athlete M',
        athleteId: 'silver-m-1',
        gender: 'M',
        weightClass: 71,
        total: 315,  // Above Senior B (309), below A (325)
        date: '2025-06-01',
        eventLevel: 4,
        level: 'International',
        birthYear: 1995,
        eventName: 'Grand Prix'
      }
    ],

    silverWomen: [
      {
        name: 'Silver Athlete F',
        athleteId: 'silver-f-1',
        gender: 'F',
        weightClass: 58,
        total: 210,  // Above Senior B (204), below A (215)
        date: '2025-07-15',
        eventLevel: 4,
        level: 'International',
        birthYear: 1998,
        eventName: 'Grand Prix'
      }
    ],

    // Bronze tier: National + Senior B + age <= 23
    bronzeMen: [
      {
        name: 'Bronze Young M',
        athleteId: 'bronze-m-1',
        gender: 'M',
        weightClass: 65,
        total: 295,  // Above Senior B (289)
        date: '2025-08-20',
        eventLevel: 3,  // National
        level: 'National',
        birthYear: 2003,  // Age 22-23 in 2026
        eventName: 'National Championships'
      }
    ],

    // Developmental tier: U15/Youth/Junior only, own age group standards
    developmental: [
      {
        name: 'Youth Dev M',
        athleteId: 'dev-1',
        gender: 'M',
        weightClass: 65,
        wcLabel: "Men's Youth 65kg",
        total: 250,  // Above Youth A (243)
        date: '2025-09-10',
        eventLevel: 3,
        level: 'National',
        birthYear: 2009,  // Age 16-17 = Youth
        eventName: 'Youth Nationals'
      },
      {
        name: 'Junior Dev F',
        athleteId: 'dev-2',
        gender: 'F',
        weightClass: 58,
        wcLabel: "Women's Junior 58kg",
        total: 200,  // Above Junior A (194)
        date: '2025-10-05',
        eventLevel: 3,
        level: 'National',
        birthYear: 2006,  // Age 19-20 = Junior
        eventName: 'Junior Nationals'
      },
      {
        name: 'U15 Dev M',
        athleteId: 'dev-3',
        gender: 'M',
        weightClass: 56,
        wcLabel: "Men's U15 56kg",
        total: 190,  // Above U15->Youth standard (181 is U15 A, uses Youth for Dev)
        date: '2025-11-15',
        eventLevel: 3,
        level: 'National',
        birthYear: 2012,  // Age 13-14 = U15
        eventName: 'U15 Nationals'
      }
    ],

    // Unqualified: Don't meet criteria
    unqualified: [
      {
        name: 'Local Only',
        athleteId: 'unq-1',
        gender: 'M',
        weightClass: 71,
        total: 280,  // Below B standard
        date: '2025-05-01',
        eventLevel: 1,  // Local
        level: 'Local',
        birthYear: 1995,
        eventName: 'Local Meet'
      },
      {
        name: 'Senior Too Old',
        athleteId: 'unq-2',
        gender: 'M',
        weightClass: 79,
        total: 340,  // Above B but age > 23 for Bronze, no intl for Gold/Silver
        date: '2025-06-01',
        eventLevel: 3,
        level: 'National',
        birthYear: 1990,  // Age 36 - too old for Bronze
        eventName: 'Nationals'
      }
    ],

    // Outside qualifying period
    outsidePeriod: [
      {
        name: 'Too Early',
        athleteId: 'outside-1',
        gender: 'M',
        weightClass: 79,
        total: 360,
        date: '2024-12-15',  // Before qualifying period
        eventLevel: 4,
        level: 'International',
        birthYear: 1999,
        eventName: 'Intl Meet'
      }
    ]
  };

  // ============================================================================
  // INTEGRATION TESTS
  // ============================================================================

  describe('NTP Selection Integration', function() {

    var ntpPeriodStart = '2026-01-25';
    var allAthletes;

    beforeEach(function() {
      // Combine all fixtures into single array
      allAthletes = [].concat(
        FIXTURES.goldMen,
        FIXTURES.goldWomen,
        FIXTURES.silverMen,
        FIXTURES.silverWomen,
        FIXTURES.bronzeMen,
        FIXTURES.developmental,
        FIXTURES.unqualified,
        FIXTURES.outsidePeriod
      );
    });

    describe('Qualifying Period Filtering', function() {

      it('should filter out performances outside qualifying period', function() {
        this.context({ domain: 'ntp', scenario: 'Period filtering' });

        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        // The "Too Early" athlete should not appear in any tier
        var allAssigned = [].concat(
          result.gold.M, result.gold.F,
          result.silver.M, result.silver.F,
          result.bronze.M, result.bronze.F,
          result.developmental,
          result.unqualified
        );

        var tooEarly = allAssigned.find(function(a) { return a.name === 'Too Early'; });
        expect(tooEarly).to.not.exist;
      });

    });

    describe('Gold Tier Assignment', function() {

      it('should assign Gold to athletes with international + Senior A', function() {
        this.context({ domain: 'ntp', tier: 'Gold' });

        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        expect(result.gold.M).to.have.length(2);
        expect(result.gold.F).to.have.length(1);

        var cj = result.gold.M.find(function(a) { return a.name === 'CJ Cummings'; });
        expect(cj).to.exist;
        expect(cj.level).to.equal('gold');

        var kate = result.gold.F.find(function(a) { return a.name === 'Kate Nye'; });
        expect(kate).to.exist;
      });

      it('should limit Gold to top 6 per gender', function() {
        this.context({ domain: 'ntp', tier: 'Gold', scenario: 'Slot limits' });

        // Add 7 more Gold-eligible men
        var moreGoldMen = [];
        for (var i = 0; i < 7; i++) {
          moreGoldMen.push({
            name: 'Extra Gold M ' + i,
            athleteId: 'extra-gold-m-' + i,
            gender: 'M',
            weightClass: 79,
            total: 350 + i,
            date: '2025-03-' + (10 + i),
            eventLevel: 4,
            level: 'International',
            birthYear: 1998 - i,
            eventName: 'World Cup'
          });
        }

        var extended = allAthletes.concat(moreGoldMen);
        var result = UsawStandards.assignNTPLevels(extended, ntpPeriodStart);

        expect(result.gold.M).to.have.length(6);
      });

    });

    describe('Silver Tier Assignment', function() {

      it('should assign Silver to athletes with international + Senior B', function() {
        this.context({ domain: 'ntp', tier: 'Silver' });

        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        var silverM = result.silver.M.find(function(a) { return a.name === 'Silver Athlete M'; });
        expect(silverM).to.exist;
        expect(silverM.level).to.equal('silver');
      });

      it('should not assign Silver to national-only performances', function() {
        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        // Bronze Young M has Senior B but only national event
        var bronzeInSilver = result.silver.M.find(function(a) { return a.name === 'Bronze Young M'; });
        expect(bronzeInSilver).to.not.exist;
      });

    });

    describe('Bronze Tier Assignment', function() {

      it('should assign Bronze to young athletes with national + Senior B', function() {
        this.context({ domain: 'ntp', tier: 'Bronze' });

        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        var bronzeM = result.bronze.M.find(function(a) { return a.name === 'Bronze Young M'; });
        expect(bronzeM).to.exist;
        expect(bronzeM.level).to.equal('bronze');
      });

      it('should exclude athletes over age 23 from Bronze', function() {
        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        // Senior Too Old meets B standard but is too old
        var oldInBronze = result.bronze.M.find(function(a) { return a.name === 'Senior Too Old'; });
        expect(oldInBronze).to.not.exist;
      });

      it('should limit Bronze to top 2 per gender', function() {
        this.context({ domain: 'ntp', tier: 'Bronze', scenario: 'Slot limits' });

        // Add 3 more Bronze-eligible young athletes
        var moreBronze = [];
        for (var i = 0; i < 3; i++) {
          moreBronze.push({
            name: 'Extra Bronze M ' + i,
            athleteId: 'extra-bronze-m-' + i,
            gender: 'M',
            weightClass: 65,
            total: 290 + i,
            date: '2025-08-' + (1 + i),
            eventLevel: 3,
            level: 'National',
            birthYear: 2003,  // Age 22-23
            eventName: 'Nationals'
          });
        }

        var extended = allAthletes.concat(moreBronze);
        var result = UsawStandards.assignNTPLevels(extended, ntpPeriodStart);

        expect(result.bronze.M).to.have.length(2);
      });

    });

    describe('Developmental Tier Assignment', function() {

      it('should assign Developmental only to U15/Youth/Junior athletes', function() {
        this.context({ domain: 'ntp', tier: 'Developmental' });

        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        // Should include Youth and Junior dev athletes
        expect(result.developmental.length).to.be.greaterThan(0);

        var youthDev = result.developmental.find(function(a) { return a.name === 'Youth Dev M'; });
        var juniorDev = result.developmental.find(function(a) { return a.name === 'Junior Dev F'; });

        expect(youthDev).to.exist;
        expect(juniorDev).to.exist;
      });

      it('should NOT include Senior athletes in Developmental', function() {
        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        // Senior athletes should not be in developmental
        var seniorInDev = result.developmental.find(function(a) {
          return a.ageGroup === 'Senior';
        });

        expect(seniorInDev).to.not.exist;
      });

      it('should rank Developmental by age-group A percentage (universal)', function() {
        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        // Dev athletes should have devRank assigned
        if (result.developmental.length > 1) {
          for (var i = 1; i < result.developmental.length; i++) {
            var prev = result.developmental[i - 1];
            var curr = result.developmental[i];

            expect(prev.percentOfAgeGroupA).to.be.gte(curr.percentOfAgeGroupA);
          }
        }
      });

      it('should limit Developmental to top 25 universal', function() {
        this.context({ domain: 'ntp', tier: 'Developmental', scenario: 'Slot limits' });

        // Add 30 Developmental-eligible athletes
        var manyDev = [];
        for (var i = 0; i < 30; i++) {
          manyDev.push({
            name: 'Dev Athlete ' + i,
            athleteId: 'dev-extra-' + i,
            gender: i % 2 === 0 ? 'M' : 'F',
            weightClass: i % 2 === 0 ? 65 : 58,
            wcLabel: i % 2 === 0 ? "Men's Youth 65kg" : "Women's Youth 58kg",
            total: i % 2 === 0 ? (200 + i) : (150 + i),
            date: '2025-09-' + ((i % 28) + 1),
            eventLevel: 3,
            level: 'National',
            birthYear: 2009,  // Youth
            eventName: 'Youth Nationals'
          });
        }

        var extended = allAthletes.concat(manyDev);
        var result = UsawStandards.assignNTPLevels(extended, ntpPeriodStart);

        expect(result.developmental).to.have.length(25);
      });

    });

    describe('Deduplication', function() {

      it('should keep only best performance per athlete', function() {
        this.context({ domain: 'ntp', scenario: 'Deduplication' });

        // Add duplicate athlete with different totals
        var duplicates = [
          {
            name: 'Multi Perf',
            athleteId: 'multi-1',
            gender: 'M',
            weightClass: 79,
            total: 350,  // Above Senior A
            date: '2025-03-15',
            eventLevel: 4,
            level: 'International',
            birthYear: 1999,
            eventName: 'Meet 1'
          },
          {
            name: 'Multi Perf',
            athleteId: 'multi-1',
            gender: 'M',
            weightClass: 79,
            total: 360,  // Higher total
            date: '2025-05-20',
            eventLevel: 4,
            level: 'International',
            birthYear: 1999,
            eventName: 'Meet 2'
          }
        ];

        var result = UsawStandards.assignNTPLevels(duplicates, ntpPeriodStart);

        // Should only have one entry for Multi Perf
        var multiPerfs = result.gold.M.filter(function(a) { return a.name === 'Multi Perf'; });
        expect(multiPerfs).to.have.length(1);

        // Should be the higher total
        expect(multiPerfs[0].total).to.equal(360);
      });

    });

    describe('Result Structure', function() {

      it('should return all required tier categories', function() {
        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        expect(result).to.have.property('gold');
        expect(result).to.have.property('silver');
        expect(result).to.have.property('bronze');
        expect(result).to.have.property('developmental');
        expect(result).to.have.property('upAndComing');
        expect(result).to.have.property('unqualified');

        expect(result.gold).to.have.property('M');
        expect(result.gold).to.have.property('F');
        expect(result.silver).to.have.property('M');
        expect(result.silver).to.have.property('F');
        expect(result.bronze).to.have.property('M');
        expect(result.bronze).to.have.property('F');
      });

      it('should include level property on all assigned athletes', function() {
        var result = UsawStandards.assignNTPLevels(allAthletes, ntpPeriodStart);

        var allAssigned = [].concat(
          result.gold.M, result.gold.F,
          result.silver.M, result.silver.F,
          result.bronze.M, result.bronze.F,
          result.developmental
        );

        allAssigned.forEach(function(athlete) {
          expect(athlete).to.have.property('level');
        });
      });

    });

  });
}

__defineModule__(_main, false);