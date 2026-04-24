function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * UISupport.unit.test.gs - Unit tests for UISupport config API
   *
   * Tests:
   * - getUiConfig() returns responseNotifications: true by default
   */

  var mocha = require('test-framework/mocha-adapter');
  var chai = require('test-framework/chai-assertions');
  var UISupport = require('sheets-chat/UISupport');

  var describe = mocha.describe;
  var it = mocha.it;
  var expect = chai.expect;

  // ============================================================================
  // getUiConfig — shape and defaults
  // ============================================================================

  describe('UISupport [getUiConfig] — config shape', function() {

    it('should return an object with autoOpenSidebar boolean', function() {
      var cfg = UISupport.getUiConfig();
      expect(cfg).to.be.an('object');
      expect(cfg.autoOpenSidebar).to.be.a('boolean');
    });

    it('should return responseNotifications: true by default', function() {
      var cfg = UISupport.getUiConfig();
      expect(cfg).to.have.property('responseNotifications');
      expect(cfg.responseNotifications).to.equal(true);
    });

  });
}

__defineModule__(_main);