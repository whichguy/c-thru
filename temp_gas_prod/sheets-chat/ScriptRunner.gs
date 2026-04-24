function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ScriptRunner — executes arbitrary JavaScript code strings in GAS context.
   *
   * Why new Function() here: the path resolver in then-later only blocks eval/Function
   * at the path level (i.e. you can't schedule "eval" as a functionPath). Once a
   * real, whitelisted function at a fixed path is invoked, it can call new Function()
   * freely on its argument. This module is that whitelisted proxy.
   *
   * Security: callers (the LLM) must confirm with the user before scheduling code
   * that writes or deletes data. See SystemPrompt.gs "# Background Task Scheduling".
   *
   * Global registration: module exports __global__ = { ScriptRunner: { runScript } }
   * so the then-later path resolver can reach it as 'ScriptRunner.runScript'
   * (the resolver only accepts word-char paths without slashes or hyphens).
   */

  /**
   * Syntax-checks a code string without executing it.
   * Called at schedule time so bad code fails fast before a job is queued.
   *
   * @param {string} code
   * @throws {SyntaxError} if the code is not valid JavaScript
   */
  function compileCheck(code) {
    // eslint-disable-next-line no-new-func
    new Function(code); // throws SyntaxError if invalid, otherwise discarded
  }

  /**
   * Executes a JavaScript code string and returns timing and result metadata.
   *
   * The code string is treated as a function body with access to all GAS global
   * services (SpreadsheetApp, DriveApp, etc.) and may use `return` to produce a value.
   *
   * @param {string} code - JavaScript code to execute (max 50,000 chars)
   * @returns {{ firedAt: string, durationMs: number, result: any }}
   */
  function runScript(code) {
    if (typeof code !== 'string' || !code) {
      throw new Error('runScript: code must be a non-empty string');
    }
    if (code.length > 50000) {
      throw new Error('runScript: code exceeds 50,000 character limit');
    }

    const firedAt = new Date().toISOString();
    const start = Date.now();
    log('[SCRIPT_FIRED] firedAt=' + firedAt);

    try {
      // new Function() is the deliberate execution mechanism here.
      // Path-level whitelist in then-later only restricts which *paths* can be scheduled,
      // not what a pre-registered function at a fixed path may execute.
      // eslint-disable-next-line no-new-func
      const fn = new Function(code);
      const result = fn();
      const durationMs = Date.now() - start;
      let resultPreview;
      try {
        const raw = JSON.stringify(result);
        resultPreview = raw !== undefined ? raw : 'undefined';
      } catch (_) {
        resultPreview = String(result);
      }
      log('[SCRIPT_DONE] durationMs=' + durationMs + ' result=' + resultPreview.substring(0, 200));
      return { firedAt, durationMs, result };
    } catch (e) {
      const durationMs = Date.now() - start;
      log('[SCRIPT_ERROR] durationMs=' + durationMs + ' error=' + e.message);
      throw e;
    }
  }

  module.exports = { runScript, compileCheck };

  // Global registration: makes 'ScriptRunner.runScript' a valid functionPath for the
  // then-later path resolver (which accepts [\w$]+\.[\w$]+ but not slashes or hyphens).
  // loadNow:true on __defineModule__ ensures this is on globalThis at trigger-fire time.
  module.exports.__global__ = { ScriptRunner: { runScript } };
}

__defineModule__(_main, true);
