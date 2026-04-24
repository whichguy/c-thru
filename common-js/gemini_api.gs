function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {

  const ConfigManager = require('common-js/ConfigManager');
  const config = new ConfigManager('GEMINI');

  const KEY_API = 'API_KEY';
  const KEY_MODEL = 'MODEL';
  const DEFAULT_MODEL = 'gemini-2.5-flash';
  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

  exports.getConfig = function() {
    log('[getConfig]');
    try {
      const key = config.get(KEY_API);
      const model = config.get(KEY_MODEL, DEFAULT_MODEL);
      return { hasKey: !!key, model };
    } catch(e) {
      return { hasKey: false, model: DEFAULT_MODEL, error: e.message };
    }
  };

  exports.saveConfig = function(key, model) {
    log(`[saveConfig] model=${model}`);
    if (!key || key.length < 30) {
      return { success: false, error: 'Invalid API key format' };
    }
    const resolvedModel = model || DEFAULT_MODEL;

    // Save first — don't block on validation
    try {
      config.setUser(KEY_API, key);
      config.setUser(KEY_MODEL, resolvedModel);
    } catch(e) {
      return { success: false, error: `Failed to save: ${e.message}` };
    }

    // Then validate with a lightweight test request
    let warning = null;
    try {
      const url = `${API_BASE}${resolvedModel}:generateContent?key=${key}`;
      const payload = {
        contents: [{ parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 5 }
      };
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      if (code === 429) {
        warning = 'Key saved. Rate limit hit during validation — try chatting in a moment.';
      } else if (code !== 200) {
        const body = JSON.parse(response.getContentText());
        warning = `Key saved but validation returned: ${body.error?.message || `HTTP ${code}`}`;
      }
    } catch(e) {
      warning = `Key saved but validation failed: ${e.message}`;
    }

    return { success: true, model: resolvedModel, warning };
  };

  exports.removeConfig = function() {
    log('[removeConfig]');
    try {
      config.delete(KEY_API, 'user');
      config.delete(KEY_MODEL, 'user');
      return { success: true };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

  // Tool definitions for Gemini function calling
  const TOOLS = [{
    functionDeclarations: [
      {
        name: 'srv_exec',
        description: 'Run JavaScript on the GAS server. Stateless per call. Use return for results.',
        parameters: {
          type: 'OBJECT',
          properties: {
            code: {
              type: 'STRING',
              description: 'JS code to run server-side. Must use return. Stateless — no variables persist between calls.'
            }
          },
          required: ['code']
        }
      },
      {
        name: 'read_editor',
        description: 'Read content. No params: active tab. tab="name": specific tab. path="common-js/file": server file source. list=true: list all tabs with dirty/active status.',
        parameters: {
          type: 'OBJECT',
          properties: {
            tab: { type: 'STRING', description: 'Read specific tab by name' },
            path: { type: 'STRING', description: 'Read server file source via ScriptApp.getResource (no extension)' },
            list: { type: 'BOOLEAN', description: 'If true, return list of all tabs' }
          }
        }
      },
      {
        name: 'write_editor',
        description: 'Write code to the editor. Can target a named tab (creates if new) or write to active tab. If the user modified the tab, returns a warning with a suggested new tab name — use it or set overwrite=true.',
        parameters: {
          type: 'OBJECT',
          properties: {
            code: { type: 'STRING', description: 'Complete code to place in the editor' },
            tab: { type: 'STRING', description: 'Optional tab name. Creates new tab if not found, switches if exists.' },
            overwrite: { type: 'BOOLEAN', description: 'If true, overwrite even if user modified the tab. Default false.' }
          },
          required: ['code']
        }
      },
      {
        name: 'run_editor',
        description: 'Run code. Default: runs editor tab visibly. mode="silent": runs code param invisibly. mode="server": runs on GAS server.',
        parameters: {
          type: 'OBJECT',
          properties: {
            mode: { type: 'STRING', description: '"client" (default, visible), "silent" (invisible, uses code param), or "server"' },
            code: { type: 'STRING', description: 'Code to run (only with mode="silent"). Omit to run editor content.' }
          }
        }
      },
      {
        name: 'read_console',
        description: 'Read recent console output entries. Use after run_editor or to check execution results.',
        parameters: {
          type: 'OBJECT',
          properties: {
            count: { type: 'NUMBER', description: 'Number of recent entries to return (default 20)' },
            level: { type: 'STRING', description: 'Filter by level: "all" (default), "info", "warn", "error", "log"' }
          }
        }
      },
      {
        name: 'read_state',
        description: 'Read the debugger state tree. Returns client-side observable state and/or last polled server state (properties, triggers, session).',
        parameters: {
          type: 'OBJECT',
          properties: {
            scope: { type: 'STRING', description: '"client", "server", or "both" (default)' },
            path: { type: 'STRING', description: 'Optional dot-path to drill into (e.g. "userProperties.MY_KEY")' }
          }
        }
      },
      {
        name: 'grep',
        description: 'Search regex across editor tabs or server files. Returns matching lines with numbers.',
        parameters: {
          type: 'OBJECT',
          properties: {
            pattern: { type: 'STRING', description: 'Regex pattern to search for' },
            scope: { type: 'STRING', description: '"tabs" (default) or "server"' },
            path: { type: 'STRING', description: 'Server file to search (e.g. "common-js/gemini_api"). Omit to search all.' },
            flags: { type: 'STRING', description: 'Regex flags (default "gi")' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'edit',
        description: 'Find-and-replace in editor tab or server file. Server files open edited copy in new tab (read-only at runtime).',
        parameters: {
          type: 'OBJECT',
          properties: {
            old_string: { type: 'STRING', description: 'Text to find (exact match)' },
            new_string: { type: 'STRING', description: 'Replacement text' },
            tab: { type: 'STRING', description: 'Target tab name (default: active tab)' },
            path: { type: 'STRING', description: 'Server file path — opens edited copy in new tab' }
          },
          required: ['old_string', 'new_string']
        }
      }
    ]
  }];

  // Run JS via the same apiExec entry point that srv.exec uses from the client.
  // This is an intentional dynamic code execution entry point for a developer tool
  // (DOMAIN-scoped access only).
  function runExec(code) {
    return apiExec({ func: code });
  }

  // System instruction — sent via Gemini's systemInstruction field (not in contents).
  // Token-efficient (~350 tokens) but highly contextual.
  function buildSystemInstruction() {
    let user = 'unknown', timezone, scriptId;
    try { user = Session.getActiveUser().getEmail(); } catch(e) {}
    try { timezone = Session.getScriptTimeZone(); } catch(e) {}
    try { scriptId = ScriptApp.getScriptId(); } catch(e) {}

    const ctx = `Script ID: ${scriptId || 'unknown'} | User: ${user} | TZ: ${timezone || 'unknown'}`;
    return [
      'You are a GAS expert assistant running in a CLIENT BROWSER (JavaScript iframe), not directly on the GAS server.',
      '',
      'ARCHITECTURE:',
      '- You run in an HtmlService IFRAME sandbox in the user\'s browser',
      '- The GAS server is accessed ONLY through tools (srv_exec) or the client\'s srv object',
      '- Server is STATELESS: each srv_exec call is isolated, no variables persist between calls',
      '- Client holds all persistent state via Observable Proxy (window.state / window.debuggerState)',
      '- V8 runtime, CommonJS modules (require.gs pattern)',
      '- ' + ctx,
      '',
      'TOOLS:',
      '- srv_exec(code): Execute JS on the GAS server. Use return for results. APIs: SpreadsheetApp, DriveApp, GmailApp, PropertiesService, CacheService, ScriptApp, Session, UrlFetchApp, etc.',
      '- read_editor(tab?, path?, list?): Read tab content, server file source, or list all tabs.',
      '- write_editor(code, tab?, overwrite?): Write code to editor. Use tab to create named tabs for new code. Gets dirty-warning if user modified — use suggested_tab or overwrite=true.',
      '- run_editor(mode?, code?): Run code. Default: visible editor run. mode="silent"+code: invisible. mode="server": GAS server.',
      '- read_console(count, level): Read recent console output entries.',
      '- read_state(scope, path): Read client/server state tree.',
      '- Use read_editor(list=true) to list tabs, srv_exec("return Object.keys(__moduleFactories__)") for server files',
      '- grep(pattern, scope?, path?): Search across tabs or server files. Returns line matches.',
      '- edit(old_string, new_string, tab?, path?): Find-replace in tab. Server files open edited copy in new tab.',
      '',
      'USER CONTEXT:',
      '- The user sees: state inspector (left), code editor + console (center), this chat (right)',
      '- The editor runs code client-side with state, srv, console in scope',
      '- srv.exec("return ...") calls the server; srv.module.fn() calls CommonJS modules',
      '- srv.SpreadsheetApp.*, srv.DriveApp.* pass through to GAS built-ins (single method call only)',
      '',
      'SAFETY \u2014 MANDATORY:',
      '- VALIDATE all code before execution: check syntax, verify intent, review for side effects',
      '- NEVER execute destructive operations without asking the user first:',
      '  * Modifying persistent state (PropertiesService, triggers, Drive files)',
      '  * Sending emails or making external API calls (UrlFetchApp, MailApp)',
      '  * Deleting or overwriting data',
      '- For write_editor: review code for correctness before placing in the editor',
      '- Quality-check all code: ensure it matches the user\'s intent and handles errors',
      '',
      'BEHAVIOR:',
      '- PREFER write_editor + run_editor for multi-line operations',
      '- Use run_editor(mode="silent", code="...") for quick invisible checks',
      '- When writing new standalone code, use write_editor with tab="descriptive name"',
      '- If write_editor returns user_modified warning, use the suggested_tab name to create a new tab',
      '- Use grep to find code patterns before making changes',
      '- Use edit for targeted changes \u2014 prefer over write_editor for small modifications',
      '- USE srv_exec to verify assumptions \u2014 don\'t guess, check',
      '- Keep answers concise and code-focused',
      '- Use write_editor to give the user runnable code',
      '- Server calls are stateless \u2014 use PropertiesService or client state for persistence',
      '- GAS limits: 6min exec, 50 UrlFetch/call, 100 email/day (consumer)',
      '- When referring to tools in text, use short names (srv_exec, not default_api.srv_exec)',
      '',
      'PROJECT FILES (all via srv_exec):',
      '- List modules: Object.keys(__moduleFactories__) \u2192 all .gs file names',
      '- Exports: Object.keys(require("common-js/name")) \u2192 exported functions',
      '- Read source: ScriptApp.getResource("common-js/gemini_api").getDataAsString() \u2192 full file',
      '- HTML too: ScriptApp.getResource("common-js/debug/debugger-ui").getDataAsString()',
      '- No extensions in names. Special: "require" (bootstrap), "appsscript" (manifest)'
    ].join('\n');
  }

  exports.chat = function(contents, model) {
    if (!contents || contents.length === 0) {
      return { success: false, error: 'No messages provided.' };
    }
    log(`[chat] contents=${contents.length} model=${model || 'default'}`);
    try {
      const key = config.get(KEY_API);
      if (!key) {
        return { success: false, error: 'No API key configured' };
      }
      const resolvedModel = model || config.get(KEY_MODEL, DEFAULT_MODEL);

      const url = `${API_BASE}${resolvedModel}:generateContent?key=${key}`;
      const maxToolRounds = 5;
      const toolLog = [];
      const sysInstruction = buildSystemInstruction();
      // Work on a local copy so the caller's array is never mutated
      const workingContents = contents.slice();

      for (let round = 0; round < maxToolRounds; round++) {
        const payload = {
          systemInstruction: { parts: [{ text: sysInstruction }] },
          contents: workingContents,
          tools: TOOLS,
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.7
          }
        };

        const response = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });

        const httpCode = response.getResponseCode();
        const rawBody = response.getContentText();
        let body;
        try {
          body = JSON.parse(rawBody);
        } catch(parseErr) {
          return { success: false, error: `HTTP ${httpCode} (non-JSON response)` };
        }

        if (httpCode !== 200) {
          return { success: false, error: body.error?.message || `HTTP ${httpCode}` };
        }

        const candidate = body.candidates?.[0];
        if (!candidate || !candidate.content) {
          return { success: true, result: { text: '', model: resolvedModel, toolLog } };
        }

        const parts = candidate.content.parts || [];
        const functionCalls = parts.filter(p => p.functionCall);
        const text = parts.filter(p => p.text).map(p => p.text).join('');

        if (functionCalls.length === 0) {
          return { success: true, result: { text, model: resolvedModel, toolLog } };
        }

        // Separate server-resolvable (srv_exec) from client-resolvable (editor ops)
        const serverCalls = functionCalls.filter(fc => fc.functionCall.name === 'srv_exec');
        const clientCalls = functionCalls.filter(fc => fc.functionCall.name !== 'srv_exec');
        // All tools except srv_exec are client-side (resolved in browser)

        // If there are client-side tools, return to client for resolution
        // Do NOT push model parts here — client handles it in handleToolCalls
        if (clientCalls.length > 0) {
          // First resolve any server calls, leave client tools unresolved
          const mixedParts = functionCalls.reduce((acc, fc) => {
            const { name: fnName, args: fnArgs = {} } = fc.functionCall;
            if (fnName === 'srv_exec') {
              const execResult = runExec(fnArgs.code);
              const toolResult = execResult.success
                ? { result: execResult.result !== undefined ? JSON.stringify(execResult.result) : 'null' }
                : { error: execResult.error };
              toolLog.push({ tool: fnName, code: fnArgs.code, result: toolResult });
              acc.push({ functionResponse: { name: fnName, response: toolResult } });
            }
            return acc;
          }, []);

          return {
            success: true,
            result: {
              text, model: resolvedModel, toolLog,
              functionCalls: clientCalls.map(fc => ({ name: fc.functionCall.name, args: fc.functionCall.args })),
              modelParts: parts,
              pendingContents: workingContents,
              resolvedServerParts: mixedParts
            }
          };
        }

        // All tools are server-side (srv_exec) — push model parts and resolve
        workingContents.push({ role: 'model', parts });
        const toolResponseParts = serverCalls.map(fc => {
          const { args: fnArgs = {} } = fc.functionCall;
          const execResult = runExec(fnArgs.code);
          const toolResult = execResult.success
            ? { result: execResult.result !== undefined ? JSON.stringify(execResult.result) : 'null' }
            : { error: execResult.error };
          toolLog.push({ tool: 'srv_exec', code: fnArgs.code, result: toolResult });
          return { functionResponse: { name: 'srv_exec', response: toolResult } };
        });

        workingContents.push({ role: 'user', parts: toolResponseParts });
      }

      return { success: false, error: `Tool call loop exceeded ${maxToolRounds} rounds` };
    } catch(e) {
      return { success: false, error: e.message };
    }
  };

}
__defineModule__(_main);
