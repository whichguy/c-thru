function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {

  exports.gather = function() {
    const diag = {};

    // === Script Identity ===
    try {
      diag.scriptId = ScriptApp.getScriptId();
    } catch(e) { diag.scriptId = `Error: ${e.message}`; }

    try {
      const service = ScriptApp.getService();
      diag.serviceUrl = service.getUrl();
      diag.serviceEnabled = service.isEnabled();
    } catch(e) { diag.serviceUrl = 'N/A'; diag.serviceEnabled = 'N/A'; }

    // === Session Info ===
    try {
      diag.activeUser = Session.getActiveUser().getEmail();
    } catch(e) { diag.activeUser = `Unavailable (${e.message})`; }

    try {
      diag.effectiveUser = Session.getEffectiveUser().getEmail();
    } catch(e) { diag.effectiveUser = 'Unavailable'; }

    try {
      diag.scriptTimeZone = Session.getScriptTimeZone();
    } catch(e) { diag.scriptTimeZone = 'Unknown'; }

    try {
      diag.tempActiveUserKey = Session.getTemporaryActiveUserKey();
    } catch(e) { diag.tempActiveUserKey = 'N/A'; }

    // === Runtime Environment ===
    diag.v8Runtime = typeof globalThis !== 'undefined';
    diag.executionTimestamp = new Date().toISOString();
    diag.locale = Session.getActiveUserLocale ? Session.getActiveUserLocale() : 'N/A';

    try {
      const token = ScriptApp.getOAuthToken();
      diag.oauthToken = token ? `Present (${token.substring(0, 12)}...)` : 'None';
    } catch(e) { diag.oauthToken = 'Error'; }

    // === Properties ===
    try {
      diag.scriptProperties = PropertiesService.getScriptProperties().getProperties();
      diag.scriptPropertiesCount = Object.keys(diag.scriptProperties).length;
    } catch(e) { diag.scriptProperties = {}; diag.scriptPropertiesCount = 0; }

    try {
      diag.userProperties = PropertiesService.getUserProperties().getProperties();
      diag.userPropertiesCount = Object.keys(diag.userProperties).length;
    } catch(e) { diag.userProperties = {}; diag.userPropertiesCount = 0; }

    // === Triggers ===
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
    } catch(e) { diag.triggerCount = 'Error'; diag.triggers = []; }

    // === Quotas ===
    try {
      diag.remainingMailQuota = MailApp.getRemainingDailyQuota();
    } catch(e) { diag.remainingMailQuota = 'N/A'; }

    // === Drive Info ===
    try {
      const file = DriveApp.getFileById(ScriptApp.getScriptId());
      diag.driveFile = {
        name: file.getName(),
        owner: file.getOwner().getEmail(),
        dateCreated: file.getDateCreated().toISOString(),
        lastUpdated: file.getLastUpdated().toISOString(),
        size: file.getSize(),
        sharingAccess: file.getSharingAccess().toString(),
        sharingPermission: file.getSharingPermission().toString()
      };
    } catch(e) { diag.driveFile = { error: e.message }; }

    // === Cache Service ===
    try {
      const cache = CacheService.getScriptCache();
      cache.put('__diag_test__', 'ok', 10);
      const val = cache.get('__diag_test__');
      diag.cacheServiceWorking = val === 'ok';
      cache.remove('__diag_test__');
    } catch(e) { diag.cacheServiceWorking = false; }

    // === OAuth Scopes (from manifest) ===
    try {
      const manifest = JSON.parse(ScriptApp.getResource('appsscript').getDataAsString());
      diag.oauthScopes = manifest.oauthScopes || [];
      diag.runtimeVersion = manifest.runtimeVersion || 'DEPRECATED_ES5';
      diag.timeZone = manifest.timeZone || 'Unknown';
      diag.webapp = manifest.webapp || null;
    } catch(e) { diag.oauthScopes = ['Error reading manifest']; }

    // === V8 / JS Engine Feature Detection ===
    const detectFeature = src => { try { return Function(`"use strict"; ${src}`)(); } catch(e) { return false; } };
    diag.jsFeatures = {
      arrowFunctions: detectFeature('return (() => true)();'),
      templateLiterals: detectFeature('return `yes` === "yes";'),
      destructuring: detectFeature('const {a} = {a:1}; return a === 1;'),
      asyncAwait: detectFeature('return async function(){}, true;'),
      optionalChaining: detectFeature('const x = {}; return x?.a === undefined;'),
      nullishCoalescing: detectFeature('return (null ?? 42) === 42;'),
      classes: detectFeature('class C {}; return true;'),
      spreadOperator: detectFeature('return [...[1,2]].length === 2;')
    };

    // === Execution Limits Reference ===
    diag.limits = {
      maxExecutionTime: '6 min (30 min Workspace)',
      maxCustomFunctionTime: '30 seconds',
      maxUrlFetchPerCall: '50 requests',
      maxPropertiesValueSize: '9 KB per value',
      maxPropertiesTotalSize: '500 KB per store',
      maxTriggers: '20 per user per script',
      maxEmailRecipients: '100/day (consumer), 1500/day (Workspace)',
      maxScriptSize: '50 MB total'
    };

    return diag;
  };

  exports.gatherLite = function() {
    const diag = {};
    diag.executionTimestamp = new Date().toISOString();

    // Session info
    diag.session = {};
    try { diag.session.activeUser = Session.getActiveUser().getEmail(); }
    catch(e) { diag.session.activeUser = 'Unavailable'; }
    try { diag.session.effectiveUser = Session.getEffectiveUser().getEmail(); }
    catch(e) { diag.session.effectiveUser = 'Unavailable'; }
    try { diag.session.timeZone = Session.getScriptTimeZone(); }
    catch(e) { diag.session.timeZone = 'Unknown'; }
    try { diag.session.locale = Session.getActiveUserLocale ? Session.getActiveUserLocale() : 'N/A'; }
    catch(e) { diag.session.locale = 'N/A'; }

    // Script Properties
    try {
      diag.scriptProperties = PropertiesService.getScriptProperties().getProperties();
    } catch(e) { diag.scriptProperties = {}; }

    // User Properties
    try {
      diag.userProperties = PropertiesService.getUserProperties().getProperties();
    } catch(e) { diag.userProperties = {}; }

    // Triggers — explicitly serialized to plain objects
    try {
      const rawTriggers = ScriptApp.getProjectTriggers();
      diag.triggerCount = rawTriggers.length;
      diag.triggers = rawTriggers.map(t => ({
        handler: t.getHandlerFunction(),
        event: t.getEventType().toString(),
        source: t.getTriggerSource().toString(),
        id: t.getUniqueId()
      }));
    } catch(e) { diag.triggerCount = 0; diag.triggers = []; }

    return diag;
  };

  exports.getQuotas = function() {
    const q = {};
    try { q.mailQuota = MailApp.getRemainingDailyQuota(); } catch(e) { q.mailQuota = 'N/A'; }
    try {
      const sp = PropertiesService.getScriptProperties().getProperties();
      q.scriptPropsSize = JSON.stringify(sp).length;
      q.scriptPropsCount = Object.keys(sp).length;
    } catch(e) { q.scriptPropsSize = 0; q.scriptPropsCount = 0; }
    try {
      const up = PropertiesService.getUserProperties().getProperties();
      q.userPropsSize = JSON.stringify(up).length;
      q.userPropsCount = Object.keys(up).length;
    } catch(e) { q.userPropsSize = 0; q.userPropsCount = 0; }
    try { q.triggerCount = ScriptApp.getProjectTriggers().length; } catch(e) { q.triggerCount = 0; }
    q.propsMaxBytes = 500 * 1024;
    q.triggerMax = 20;
    return q;
  };

}
__defineModule__(_main);
