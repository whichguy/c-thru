function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  function double(x) { return x * 2; }
  function triple(x) { return x * 3; }
  function square(x) { return x * x; }
  module.exports = { double, triple, square };
}

__defineModule__(_main);