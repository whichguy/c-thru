function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const stringUtils = require("StringUtils");
  function formatMessage(msg) {
    return "MESSAGE: " + stringUtils.toUpper(msg);
  }
  module.exports = { formatMessage };
}

__defineModule__(_main);