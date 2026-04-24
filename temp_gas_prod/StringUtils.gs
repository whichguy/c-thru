function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  function toUpper(s) { return s.toUpperCase(); }
  module.exports = { toUpper };
}

__defineModule__(_main);