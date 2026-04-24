// --- Top-level functions (outside _main) for scripts.run API ---
// These run during V8 file loading, before any module code.
// Using globalThis[] makes them accessible from any file loaded via require().

/**
 * Set execution context on globalThis — accessible across ALL files.
 * Consumer shim calls this before exec_api() to pass bound spreadsheet ID.
 */
function setContext(ctx) {
  if (ctx.spreadsheetId) globalThis.__SPREADSHEET_ID__ = ctx.spreadsheetId;
  if (ctx.ui) globalThis.__UI__ = ctx.ui;
}

/**
 * Transparent replacement for getActiveSpreadsheet().
 * Works in both container-bound (native) and standalone (configured ID) contexts.
 */
function getSpreadsheet() {
  if (globalThis.__SPREADSHEET_ID__) return SpreadsheetApp.openById(globalThis.__SPREADSHEET_ID__);
  try { var ss = SpreadsheetApp.getActiveSpreadsheet(); if (ss) return ss; } catch(e) {}
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (id) return SpreadsheetApp.openById(id);
  } catch(e) {}
  return null;
}

globalThis.getSpreadsheet = getSpreadsheet;
globalThis.setContext = setContext;

/**
 * Top-level entry point for scripts.run API.
 * Executes arbitrary JS via Function constructor for dynamic code evaluation.
 * Intentionally uses Function constructor for dynamic JS execution.
 */
function apiExec(params) {
  try {
    if (params && params.spreadsheetId) globalThis.__SPREADSHEET_ID__ = params.spreadsheetId;
    var func = (params && params.func) ? params.func : 'return null';
    // eslint-disable-next-line no-new-func -- intentional dynamic execution entry point
    var result = (new Function(func))();
    return { success: true, result: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  __events__ = module.__events__,
  __global__ = module.__global__
) {
  // ⚠ Shared helpers — match mcp_gas reference patterns (~/src/gas_mcp/src/__mcp_exec.js)

  /** Extract JS from POST body: JSON { func: "..." } or raw JS fallback */
  // ⚠ Per-request size limit. GAS execution time limits (6 min/web app) provide burst protection.
  var MAX_POST_SIZE = 65536; // 64 KB — prevents quota exhaustion from single malformed payload
  function extractPostData(postData) {
    if (!postData) return '';
    if (postData.length > MAX_POST_SIZE) {
      throw new Error('POST body exceeds maximum size (' + MAX_POST_SIZE + ' bytes)');
    }
    try {
      var parsed = JSON.parse(postData);
      return parsed.func || '';
    } catch (e) {
      return postData.trim(); // Raw JS fallback
    }
  }

  /** JSON response helper */
  function jsonResponse(data) {
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  /**
   * doPost handler for web app fallback execution.
   * Convention: returns null if not an MCP request (handler chaining).
   * Matches gasExecutor.ts contract: { success, result, error, logger_output }
   *
   * ⚠ This enables exec when scripts.run is unavailable (no GCP switch).
   *   gasExecutor.ts sends: POST {url}/mcp body: { func: "..." }
   *
   * Routing: Primary: e.pathInfo === 'mcp' (path-based, /exec/mcp).
   *          Fallback: e.parameter._mcp_run === 'true' (legacy query param, backward compat).
   *
   * SECURITY: Path/query routing is a convention, NOT an auth boundary.
   * Access control is enforced by GAS deployment settings:
   *   Execute as: USER_ACCESSING | Who has access: MYSELF or DOMAIN
   * The create tool sets these defaults. Do NOT deploy with "Anyone" access.
   */
  function handleDoPost(e) {
    // Gate: only handle MCP exec requests
    // Primary: path-based routing (/exec/mcp)
    // Fallback: legacy query param (?_mcp_run=true) for backward compat
    if (!e || (e.pathInfo !== 'mcp' && (!e.parameter || e.parameter._mcp_run !== 'true'))) {
      return null; // Not ours — skip to next handler
    }

    // ⚠ e.postData may be null on empty-body POSTs
    if (!e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: 'Missing POST body' });
    }

    try {
      var js_statement = extractPostData(e.postData.contents);
      if (!js_statement) {
        return jsonResponse({ success: false, error: 'No JavaScript code provided' });
      }

      // Reuse top-level apiExec() — same Function constructor pattern,
      // same spreadsheetId injection, same response format.
      var result = apiExec({ func: js_statement });

      // apiExec returns { success, result } or { success, error } — add logger_output
      result.logger_output = Logger.getLog();
      return jsonResponse(result);
    } catch (execErr) {
      return jsonResponse({
        success: false, error: execErr.message, logger_output: Logger.getLog()
      });
    }
  }

  /**
   * doGet handler — browser authorization landing page.
   * When exec detects a new project needs browser consent, it tells the user to
   * open the deployment URL. The browser sends GET, which lands here.
   * Simply visiting the URL authorizes the web app for the user's session.
   *
   * Routing: Serves auth page for /exec/mcp AND base /exec (no pathInfo) for backward compat.
   * Only yields to user handlers when pathInfo is present and NOT 'mcp'.
   *
   * ⚠ No size limit needed: returns static HTML without processing e.parameter or e.postData.
   */
  function handleDoGet(e) {
    // Yield to user handlers: pathInfo routing (non-mcp paths) or query param routing (?page=)
    if (e && e.pathInfo && e.pathInfo !== 'mcp') return null;
    if (e && e.parameter && e.parameter.page) return null;
    return HtmlService.createHtmlOutput(
      '<h2>MCP GAS Deploy — Authorized</h2>' +
      '<p>This web app is now authorized for your account.</p>' +
      '<p id="countdown">This tab will close in <strong>5</strong> seconds...</p>' +
      '<script>' +
        'var n=5;' +
        'var t=setInterval(function(){' +
          'n--;' +
          'if(n<=0){clearInterval(t);try{window.top.close()}catch(e){document.getElementById("countdown").innerHTML="You can close this tab now."}}' +
          'else{document.querySelector("#countdown strong").textContent=n}' +
        '},1000);' +
      '</script>'
    ).setTitle('MCP GAS Deploy');
  }

  exports.handleDoPost = handleDoPost;
  exports.handleDoGet = handleDoGet;
  // ⚠ Register via module.exports.__events__ (NOT the __events__ parameter —
  // require.gs __findEventHandlers__ reads module.exports.__events__)
  exports.__events__ = { doGet: 'handleDoGet', doPost: 'handleDoPost' };
}

__defineModule__(_main, 'common-js/__mcp_exec', {loadNow: true});
