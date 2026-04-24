// ARCH: Property defaults live in the library (gas-deployment/property_defaults), not the consumer.
// ARCH: GAS PropertiesService is SHARED — library code reads the CONSUMER's Script Properties.
// ARCH: This module applies missing defaults to the consumer's PropertiesService on each onOpen.
// ARCH: Copied spreadsheets have empty PropertiesService — applyPropertyDefaults bootstraps them.
function _main(module, exports, log) {

  /**
   * Apply property defaults to the consumer's Script Properties.
   * Only fills in missing keys — user-customized values are preserved.
   * Uses a version sentinel (_DEFAULTS_V) for fast-path skip on subsequent opens.
   *
   * Called from the consumer shim's onOpen/onInstall:
   *   MyApp.applyPropertyDefaults();
   */
  function applyPropertyDefaults() {
    var defs;
    try {
      defs = require('gas-deployment/property_defaults');
    } catch (e) {
      // No property_defaults module — nothing to apply (project has no promote-time defaults)
      return;
    }

    if (!defs || !defs.defaults) return;

    var sp = PropertiesService.getScriptProperties();
    // Fast path: sentinel matches current version — no work needed
    if (sp.getProperty('_DEFAULTS_V') === String(defs.version)) return;

    var current = sp.getProperties();
    var updates = {};
    var keys = Object.keys(defs.defaults);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!(k in current)) {
        updates[k] = defs.defaults[k];
      }
    }
    // Batch write — single API call instead of per-key round trips
    if (Object.keys(updates).length > 0) {
      sp.setProperties(updates, false);
    }
    sp.setProperty('_DEFAULTS_V', String(defs.version));
  }

  module.exports = {
    applyPropertyDefaults: applyPropertyDefaults
  };

  // Expose to library namespace so consumer shim can call MyApp.applyPropertyDefaults()
  module.exports.__global__ = {
    applyPropertyDefaults: module.exports.applyPropertyDefaults
  };
}
__defineModule__(_main, null, { loadNow: true });
