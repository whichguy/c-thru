function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  function add(a,b) { return a + b; }
  function multiply(a,b) { return a * b; }
  module.exports = { add, multiply };
}

__defineModule__(_main);