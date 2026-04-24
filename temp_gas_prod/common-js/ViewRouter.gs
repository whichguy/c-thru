function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ViewRouter - Centralized ?view= URL routing for web app deployments.
   */
  const ROUTES = {
    'sidebar': { templatePath: 'sheets-sidebar/Sidebar', title: 'Sheet Chat' }
  };

  function sanitizeSsid(ssid) {
    return (ssid || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 44);
  }

  function route(e) {
    if (!e?.parameter?.view) return null;
    const config = ROUTES[e.parameter.view];
    if (!config) {
      log('[ViewRouter] Unknown view: ' + e.parameter.view);
      return null;
    }
    try {
      const template = HtmlService.createTemplateFromFile(config.templatePath);
      template.ssid = sanitizeSsid(e.parameter.ssid);
      template.isWebAppMode = true;
      return template.evaluate()
        .setTitle(config.title)
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    } catch (err) {
      log('[ViewRouter] Template error: ' + config.templatePath + ' - ' + err.message);
      return null;
    }
  }

  function registerRoute(view, config) {
    ROUTES[view] = config;
  }

  module.exports = { route, registerRoute, ROUTES };
}

__defineModule__(_main);