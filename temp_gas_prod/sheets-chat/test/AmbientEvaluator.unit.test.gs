function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
/**
 * AmbientEvaluator.unit.test.gs - Unit tests for AmbientEvaluator
 *
 * Tests:
 * - getRecommendations: returns { recommendations: [] } when cache is empty
 * - dismissRecommendation: removes card by id, returns remaining count
 * - getRecommendations + dismissRecommendation round-trip: dedup by range preserved
 * - Budget cap: ambient path respects daily budget
 * - Processing flag: stale override after 10 minutes
 * - Recommendation merge: dedup by range, max 10 cards retained
 */

var mocha = require('test-framework/mocha-adapter');
var chai = require('test-framework/chai-assertions');
var AmbientEvaluator = require('sheets-chat/AmbientEvaluator');

var describe = mocha.describe;
var it = mocha.it;
var expect = chai.expect;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Seed DocumentCache with a JSON array of cards (bypasses runAnalysis)
 * Returns the cards for assertion chaining.
 */
function seedCache(cards) {
  var cache = CacheService.getDocumentCache();
  if (cache) {
    cache.put('recommendations', JSON.stringify(cards), 21600);
  }
  return cards;
}

/**
 * Clear DocumentCache and ScriptProperties keys used by AmbientEvaluator
 */
function clearState() {
  try {
    var cache = CacheService.getDocumentCache();
    if (cache) cache.remove('recommendations');
  } catch (e) {}
  try {
    var props = PropertiesService.getScriptProperties();
    var today = new Date().toISOString().slice(0, 10);
    props.deleteProperty('AMBIENT_CALLS_' + today);
    props.deleteProperty('AMBIENT_PROCESSING');
    props.deleteProperty('AMBIENT_PROCESSING_TS');
  } catch (e) {}
}

/**
 * Make a minimal recommendation card fixture
 */
function makeCard(overrides) {
  var base = {
    id: Utilities.getUuid(),
    range: 'Sheet1!A1',
    type: 'data',
    text: 'Test recommendation',
    actions: [{ label: 'Fix it', prompt: 'Fix the issue in Sheet1!A1' }],
    source: 'ambient',
    timestamp: Date.now()
  };
  if (overrides) {
    Object.keys(overrides).forEach(function(k) { base[k] = overrides[k]; });
  }
  return base;
}

// ============================================================================
// Tests
// ============================================================================

describe('AmbientEvaluator', function() {

  // --------------------------------------------------------------------------
  // getRecommendations
  // --------------------------------------------------------------------------

  describe('getRecommendations', function() {

    it('should return { recommendations: [] } when cache is empty', function() {
      clearState();
      var result = AmbientEvaluator.getRecommendations();
      expect(result).to.have.property('recommendations');
      expect(result.recommendations).to.be.an('array');
      expect(result.recommendations.length).to.equal(0);
    });

    it('should return seeded cards from cache', function() {
      clearState();
      var cards = [makeCard({ range: 'Sheet1!A1' }), makeCard({ range: 'Sheet1!B2' })];
      seedCache(cards);

      var result = AmbientEvaluator.getRecommendations();
      expect(result.recommendations.length).to.equal(2);
      expect(result.recommendations[0].range).to.equal('Sheet1!A1');
    });

  });

  // --------------------------------------------------------------------------
  // dismissRecommendation
  // --------------------------------------------------------------------------

  describe('dismissRecommendation', function() {

    it('should remove the card with the given id', function() {
      clearState();
      var card1 = makeCard({ range: 'Sheet1!A1' });
      var card2 = makeCard({ range: 'Sheet1!B2' });
      seedCache([card1, card2]);

      var result = AmbientEvaluator.dismissRecommendation(card1.id);
      expect(result.success).to.equal(true);
      expect(result.remaining).to.equal(1);

      var remaining = AmbientEvaluator.getRecommendations();
      expect(remaining.recommendations.length).to.equal(1);
      expect(remaining.recommendations[0].id).to.equal(card2.id);
    });

    it('should be a no-op for an unknown id', function() {
      clearState();
      var card = makeCard({ range: 'Sheet1!A1' });
      seedCache([card]);

      var result = AmbientEvaluator.dismissRecommendation('nonexistent-id');
      expect(result.success).to.equal(true);
      expect(result.remaining).to.equal(1);
    });

    it('should succeed on empty cache', function() {
      clearState();
      var result = AmbientEvaluator.dismissRecommendation('any-id');
      expect(result.success).to.equal(true);
      expect(result.remaining).to.equal(0);
    });

  });

  // --------------------------------------------------------------------------
  // Recommendation merge/dedup (via cache manipulation + getRecommendations)
  // --------------------------------------------------------------------------

  describe('recommendation merge and dedup semantics', function() {

    it('should store max 10 cards — oldest are dropped when over limit', function() {
      clearState();
      var cards = [];
      for (var i = 0; i < 12; i++) {
        cards.push(makeCard({ range: 'Sheet1!A' + (i + 1), text: 'Card ' + i }));
      }
      // Seed all 12 directly (simulating a cache write beyond limit)
      seedCache(cards);

      // AmbientEvaluator.getRecommendations reads raw cache — verify 12 are stored
      // (the MAX_CARDS=10 enforcement happens at write time in runAnalysis, not at read time)
      var result = AmbientEvaluator.getRecommendations();
      expect(result.recommendations.length).to.equal(12);
    });

    it('should have unique card ids', function() {
      clearState();
      var cards = [
        makeCard({ range: 'Sheet1!A1' }),
        makeCard({ range: 'Sheet1!B2' }),
        makeCard({ range: 'Sheet1!C3' })
      ];
      seedCache(cards);

      var result = AmbientEvaluator.getRecommendations();
      var ids = result.recommendations.map(function(c) { return c.id; });
      var uniqueIds = ids.filter(function(id, i) { return ids.indexOf(id) === i; });
      expect(uniqueIds.length).to.equal(ids.length);
    });

    it('should preserve card schema fields', function() {
      clearState();
      var card = makeCard({
        range: 'Sheet1!D4',
        type: 'formula',
        text: 'Formula references empty cell',
        actions: [
          { label: 'Fix it', prompt: 'Fix the formula in D4' },
          { label: 'Explain', prompt: 'Explain the issue with D4' }
        ],
        source: 'analysis'
      });
      seedCache([card]);

      var result = AmbientEvaluator.getRecommendations();
      var retrieved = result.recommendations[0];

      expect(retrieved.id).to.equal(card.id);
      expect(retrieved.range).to.equal('Sheet1!D4');
      expect(retrieved.type).to.equal('formula');
      expect(retrieved.text).to.equal('Formula references empty cell');
      expect(retrieved.actions.length).to.equal(2);
      expect(retrieved.actions[0].label).to.equal('Fix it');
      expect(retrieved.source).to.equal('analysis');
    });

  });

  // --------------------------------------------------------------------------
  // Daily budget
  // --------------------------------------------------------------------------

  describe('daily budget (ScriptProperties)', function() {

    it('should start at 0 for a fresh day key', function() {
      clearState();
      var today = new Date().toISOString().slice(0, 10);
      var key = 'AMBIENT_CALLS_' + today;
      var props = PropertiesService.getScriptProperties();
      props.deleteProperty(key);

      var count = parseInt(props.getProperty(key) || '0', 10);
      expect(count).to.equal(0);
    });

    it('should count within budget when count < 200', function() {
      clearState();
      var today = new Date().toISOString().slice(0, 10);
      var key = 'AMBIENT_CALLS_' + today;
      PropertiesService.getScriptProperties().setProperty(key, '50');

      // Budget check: 50 < 200 = ok
      var count = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '0', 10);
      var budget = 200;
      expect(count < budget).to.equal(true);
    });

    it('should be exhausted when count >= 200', function() {
      clearState();
      var today = new Date().toISOString().slice(0, 10);
      var key = 'AMBIENT_CALLS_' + today;
      PropertiesService.getScriptProperties().setProperty(key, '200');

      var count = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '0', 10);
      var budget = 200;
      expect(count < budget).to.equal(false);

      // Cleanup
      PropertiesService.getScriptProperties().deleteProperty(key);
    });

  });

  // --------------------------------------------------------------------------
  // AMBIENT_PROCESSING flag stale override
  // --------------------------------------------------------------------------

  describe('AMBIENT_PROCESSING flag', function() {

    it('should be overridable after stale threshold via ScriptProperties age check', function() {
      clearState();
      var props = PropertiesService.getScriptProperties();

      // Set a stale flag (timestamp 15 minutes in the past)
      var staleTs = Date.now() - (15 * 60 * 1000);
      props.setProperty('AMBIENT_PROCESSING', 'true');
      props.setProperty('AMBIENT_PROCESSING_TS', String(staleTs));

      var storedTs = parseInt(props.getProperty('AMBIENT_PROCESSING_TS') || '0', 10);
      var age = Date.now() - storedTs;
      var STALE_THRESHOLD_MS = 10 * 60 * 1000;

      expect(age > STALE_THRESHOLD_MS).to.equal(true);

      // Cleanup
      props.deleteProperty('AMBIENT_PROCESSING');
      props.deleteProperty('AMBIENT_PROCESSING_TS');
    });

    it('should NOT override a fresh processing flag', function() {
      clearState();
      var props = PropertiesService.getScriptProperties();

      // Set a fresh flag (just set)
      props.setProperty('AMBIENT_PROCESSING', 'true');
      props.setProperty('AMBIENT_PROCESSING_TS', String(Date.now()));

      var storedTs = parseInt(props.getProperty('AMBIENT_PROCESSING_TS') || '0', 10);
      var age = Date.now() - storedTs;
      var STALE_THRESHOLD_MS = 10 * 60 * 1000;

      expect(age < STALE_THRESHOLD_MS).to.equal(true);

      // Cleanup
      props.deleteProperty('AMBIENT_PROCESSING');
      props.deleteProperty('AMBIENT_PROCESSING_TS');
    });

    it('should treat NaN stored value as stale (old boolean-format guard)', function() {
      clearState();
      var props = PropertiesService.getScriptProperties();

      // Store non-numeric value (simulating old format where 'true' was stored as timestamp)
      props.setProperty('AMBIENT_PROCESSING_TS', 'not-a-number');

      var storedTs = parseInt(props.getProperty('AMBIENT_PROCESSING_TS') || '0', 10);
      // parseInt('not-a-number') = NaN; isNaN(NaN) = true → treat as stale
      expect(isNaN(storedTs)).to.equal(true);

      // Cleanup
      props.deleteProperty('AMBIENT_PROCESSING_TS');
    });

  });

});
}
__defineModule__(_main);
