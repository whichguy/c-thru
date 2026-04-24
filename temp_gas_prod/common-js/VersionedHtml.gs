function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Versioned HTML loading for sidebars/dialogs via iframe (staging/prod) or direct (dev).
   */
  const __mcp_exec = require('common-js/__mcp_exec');
  const DEFAULTS = { sidebarWidth: 400, dialogWidth: 600, dialogHeight: 400, timeout: 15000 };

  function isValidDeploymentUrl(url) {
    return url && typeof url === 'string' && url.startsWith('https://script.google.com/');
  }

  function createVersionedShell(opts) {
    const { environment = 'default', view, templatePath, title = 'Sheet Chat', ssid, timeout = DEFAULTS.timeout } = opts;

    // Dev: direct template load
    if (environment === 'default' || environment === 'dev') {
      if (!templatePath) throw new Error('templatePath required for dev mode');
      try {
        const template = HtmlService.createTemplateFromFile(templatePath);
        template.isWebAppMode = false;
        template.ssid = '';
        return template.evaluate().setTitle(title);
      } catch (err) {
        throw new Error('Template not found: ' + templatePath);
      }
    }

    // Staging/Prod: iframe shell
    const urls = __mcp_exec.getDeploymentUrls();
    const deploymentUrl = urls[environment];
    if (!deploymentUrl) throw new Error('No ' + environment + ' deployment URL configured. Run MCP deploy first.');
    if (!isValidDeploymentUrl(deploymentUrl)) throw new Error('Invalid deployment URL: ' + deploymentUrl);

    // Build iframe URL with spreadsheet context
    const ss = ssid ? null : SpreadsheetApp.getActiveSpreadsheet();
    const spreadsheetId = ssid || (ss ? ss.getId() : '');
    const iframeUrl = deploymentUrl + '?view=' + encodeURIComponent(view || 'sidebar') + '&ssid=' + encodeURIComponent(spreadsheetId);
    const urlPreview = iframeUrl.length > 60 ? iframeUrl.substring(0, 60) + '...' : iframeUrl;

    // Load shell template with iframe
    try {
      const shell = HtmlService.createTemplateFromFile('common-js/html/versioned_shell');
      shell.environment = environment;
      shell.iframeUrl = iframeUrl;
      shell.urlPreview = urlPreview;
      shell.timeout = timeout;
      return shell.evaluate().setTitle(title);
    } catch (err) {
      throw new Error('Shell template not found: common-js/html/versioned_shell');
    }
  }

  function showSidebar(opts) {
    if (!opts) { SpreadsheetApp.getUi().alert('Error', 'showSidebar: opts required', SpreadsheetApp.getUi().ButtonSet.OK); return; }
    const width = opts.width || DEFAULTS.sidebarWidth;
    try {
      const html = createVersionedShell(opts).setWidth(width);
      SpreadsheetApp.getUi().showSidebar(html);
    } catch (err) {
      SpreadsheetApp.getUi().alert('Sidebar Error', err.message, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }

  function showDialog(opts) {
    if (!opts) { SpreadsheetApp.getUi().alert('Error', 'showDialog: opts required', SpreadsheetApp.getUi().ButtonSet.OK); return; }
    const width = opts.width || DEFAULTS.dialogWidth;
    const height = opts.height || DEFAULTS.dialogHeight;
    try {
      const html = createVersionedShell(opts).setWidth(width).setHeight(height);
      SpreadsheetApp.getUi().showModalDialog(html, opts.title || 'Dialog');
    } catch (err) {
      SpreadsheetApp.getUi().alert('Dialog Error', err.message, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }

  function showModelessDialog(opts) {
    if (!opts) { SpreadsheetApp.getUi().alert('Error', 'showModelessDialog: opts required', SpreadsheetApp.getUi().ButtonSet.OK); return; }
    const width = opts.width || DEFAULTS.dialogWidth;
    const height = opts.height || DEFAULTS.dialogHeight;
    try {
      const html = createVersionedShell(opts).setWidth(width).setHeight(height);
      SpreadsheetApp.getUi().showModelessDialog(html, opts.title || 'Dialog');
    } catch (err) {
      SpreadsheetApp.getUi().alert('Dialog Error', err.message, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }

  module.exports = { createVersionedShell, showSidebar, showDialog, showModelessDialog, isValidDeploymentUrl };
}

__defineModule__(_main);