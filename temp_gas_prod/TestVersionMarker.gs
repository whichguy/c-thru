function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  // VERSION_MARKER: v1_test_20240119
  // This file tests if ScriptApp.getResource() returns HEAD or deployed content

  function getMarker() {
    return 'v1_test_20240119';
  }

  module.exports = { getMarker };
}

__defineModule__(_main);