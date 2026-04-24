function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  // Re-export canonical ConfigManager from common-js location
  module.exports = require('common-js/ConfigManager');
}

__defineModule__(_main, false);