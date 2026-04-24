function _main(module = globalThis.__getCurrentModule(), exports = module.exports) {
  const diagnostics = require('common-js/diagnostics');

  function handleGet(e) {
    if (!e) return null;

    // Support both pathInfo (/_debug, /_diagnostics) and query param (?page=...)
    const page = e.pathInfo || (e.parameter && e.parameter.page) || null;
    if (!page) return null;

    if (page === '_debug' || page === 'debugger') {
      const debugData = diagnostics.gatherLite();
      const debugTemplate = HtmlService.createTemplateFromFile('common-js/debug/debugger-ui');
      debugTemplate.data = debugData;
      return debugTemplate.evaluate()
        .setTitle('GAS Debugger')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    if (page === '_diagnostics' || page === 'diagnostics') {
      const data = diagnostics.gather();
      const template = HtmlService.createTemplateFromFile('common-js/debug/diagnostics-ui');
      template.data = data;
      return template.evaluate()
        .setTitle('GAS Project Diagnostics')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    return null; // Not our route -- yield to other handlers
  }

  module.exports = { handleGet: handleGet };
  module.exports.__events__ = { doGet: 'handleGet' };
}
__defineModule__(_main, 'common-js/triggers', { loadNow: true });
