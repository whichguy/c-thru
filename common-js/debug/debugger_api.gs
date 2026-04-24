function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {

  const getProps = store => store === 'script'
    ? PropertiesService.getScriptProperties()
    : PropertiesService.getUserProperties();

  exports.getStateLite = () => {
    const diag = { executionTimestamp: new Date().toISOString() };

    try {
      diag.scriptProperties = PropertiesService.getScriptProperties().getProperties();
      diag.scriptPropertiesCount = Object.keys(diag.scriptProperties).length;
    } catch(e) { diag.scriptProperties = {}; diag.scriptPropertiesCount = 0; }

    try {
      diag.userProperties = PropertiesService.getUserProperties().getProperties();
      diag.userPropertiesCount = Object.keys(diag.userProperties).length;
    } catch(e) { diag.userProperties = {}; diag.userPropertiesCount = 0; }

    try {
      const triggers = ScriptApp.getProjectTriggers();
      diag.triggerCount = triggers.length;
      diag.triggers = triggers.map(t => ({
        handlerFunction: t.getHandlerFunction(),
        eventType: t.getEventType().toString(),
        triggerSource: t.getTriggerSource().toString(),
        triggerSourceId: t.getTriggerSourceId() || 'N/A',
        uniqueId: t.getUniqueId()
      }));
    } catch(e) { diag.triggerCount = 0; diag.triggers = []; }

    return diag;
  };

  exports.setProperty = (store, key, val) => {
    log(`[setProperty] store=${store} key=${key}`);
    if (!key) return { success: false, error: 'Key is required.' };
    if (store !== 'script' && store !== 'user') {
      return { success: false, error: `Invalid store: ${store}. Must be "script" or "user".` };
    }
    try {
      getProps(store).setProperty(key, String(val));
      return { success: true, key, value: String(val), store };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  exports.deleteProperty = (store, key) => {
    log(`[deleteProperty] store=${store} key=${key}`);
    if (!key) return { success: false, error: 'Key is required.' };
    if (store !== 'script' && store !== 'user') {
      return { success: false, error: `Invalid store: ${store}` };
    }
    try {
      getProps(store).deleteProperty(key);
      return { success: true, key, store };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  exports.deleteTrigger = uniqueId => {
    log(`[deleteTrigger] uniqueId=${uniqueId}`);
    if (!uniqueId) return { success: false, error: 'uniqueId is required.' };
    try {
      const trigger = ScriptApp.getProjectTriggers().find(t => t.getUniqueId() === uniqueId);
      if (!trigger) return { success: false, error: `Trigger not found: ${uniqueId}` };
      ScriptApp.deleteTrigger(trigger);
      return { success: true, deletedId: uniqueId };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  exports.setCacheValue = (key, val, ttl) => {
    log(`[setCacheValue] key=${key} ttl=${ttl}`);
    if (!key) return { success: false, error: 'Key is required.' };
    if (val === undefined || val === null) return { success: false, error: 'Value is required.' };
    try {
      const safeTtl = (typeof ttl === 'number' && ttl > 0 && ttl <= 21600) ? ttl : 600;
      CacheService.getScriptCache().put(key, String(val), safeTtl);
      return { success: true, key };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  exports.getCacheValue = key => {
    log(`[getCacheValue] key=${key}`);
    if (!key) return { success: false, error: 'Key is required.' };
    try {
      const val = CacheService.getScriptCache().get(key);
      return { success: true, key, value: val, found: val !== null };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  exports.removeCacheValue = key => {
    log(`[removeCacheValue] key=${key}`);
    if (!key) return { success: false, error: 'Key is required.' };
    try {
      CacheService.getScriptCache().remove(key);
      return { success: true, key };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  exports.execWithNetworkLog = code => {
    log('[execWithNetworkLog]');
    const fetchLog = [];
    const origFetch = UrlFetchApp.fetch;
    const origFetchAll = UrlFetchApp.fetchAll;

    UrlFetchApp.fetch = (url, params) => {
      const start = Date.now();
      try {
        const resp = origFetch.call(UrlFetchApp, url, params);
        fetchLog.push({
          url: String(url).substring(0, 200),
          method: (params && params.method) || 'GET',
          status: resp.getResponseCode(),
          ms: Date.now() - start,
          responseSize: resp.getContentText().length
        });
        return resp;
      } catch(e) {
        fetchLog.push({ url: String(url).substring(0, 200), method: (params && params.method) || 'GET', error: e.message, ms: Date.now() - start });
        throw e;
      }
    };

    UrlFetchApp.fetchAll = requests => {
      const start = Date.now();
      try {
        const responses = origFetchAll.call(UrlFetchApp, requests);
        responses.forEach((resp, i) => {
          const req = requests[i] || {};
          fetchLog.push({
            url: String(req.url || '').substring(0, 200),
            method: req.method || 'GET',
            status: resp.getResponseCode(),
            ms: Date.now() - start,
            responseSize: resp.getContentText().length
          });
        });
        return responses;
      } catch(e) {
        fetchLog.push({ url: 'fetchAll', method: 'batch', error: e.message, ms: Date.now() - start });
        throw e;
      }
    };

    try {
      const result = apiExec({ func: code });
      result.fetchLog = fetchLog;
      return result;
    } finally {
      UrlFetchApp.fetch = origFetch;
      UrlFetchApp.fetchAll = origFetchAll;
    }
  };

  exports.getProjectFiles = () => {
    const files = [];
    const tryResource = name => { try { ScriptApp.getResource(name); return true; } catch(e) { return false; } };

    // .gs modules from factories
    for (const name of Object.keys(globalThis.__moduleFactories__ || {})) {
      if (tryResource(name)) files.push({ name, type: 'gs' });
    }

    // Known HTML files
    const htmlNames = [
      'common-js/debug/debugger-ui', 'common-js/debug/debugger-core',
      'common-js/debug/debugger-styles', 'common-js/debug/debugger-state-inspector',
      'common-js/debug/debugger-timeline', 'common-js/debug/debugger-codemirror',
      'common-js/debug/debugger-code-editor', 'common-js/debug/debugger-gemini-chat',
      'common-js/debug/diagnostics-ui'
    ];
    for (const name of htmlNames) {
      if (tryResource(name)) files.push({ name, type: 'html' });
    }

    // Special files
    if (tryResource('require')) files.push({ name: 'require', type: 'gs' });
    if (tryResource('appsscript')) files.push({ name: 'appsscript', type: 'json' });

    return files;
  };

}
__defineModule__(_main);
