function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * SpreadsheetToolHandler - Executes JavaScript with SpreadsheetApp context
   * Provides the 'exec' tool for Claude AI to interact with Google Sheets
   * Extends ToolBase for consistent behavior
   */

  class SpreadsheetToolHandler extends require('tools/ToolBase') {
    constructor() {
      super('exec');
    }
    
    /**
     * Returns the Claude API tool definition for the 'exec' tool
     * @returns {Object} Tool definition with comprehensive documentation
     */
    getToolDefinition() {
      return {
        name: "exec",
        description: `Execute JavaScript code with SpreadsheetApp and ScriptApp in context.

  DOCUMENTATION:
  - SpreadsheetApp: https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app
  - ScriptApp: https://developers.google.com/apps-script/reference/script/sAVAILABLE OBJECTS:
    - SpreadsheetApp: Global spreadsheet service
    - ScriptApp: Global script service  
    - toolState: In-memory state object (shared across tool calls in same conversation)
      - toolState.previousResult: Automatically contains the previous tool's return value
    - fetch(input): Make HTTP requests (returns result object)
    - knowledge(input): Query knowledge base
    - askllm(input): Execute prompts
    - analyzeUrl(input): Analyze URLs
    - thinking(msg): Progress updates shown in sidebar UI AND server logs.

      WHEN TO USE (user sees these in real-time):
      • Before major operations: thinking('Fetching data | 50 URLs')
      • Every 10 iterations in loops: if (i % 10 === 0) thinking(\`Processing \${i}/\${total}\`)
      • After milestones: thinking('Batch complete | 500 records')

      FORMAT: 'User-friendly message | technical details'

      LOOP PATTERN (mandatory for >10 iterations):
      for (let i = 0; i < items.length; i++) {
        if (i % 10 === 0) thinking(\`Processing \${i}/\${items.length}\`);
        // ... work
      }
      thinking(\`Complete | \${items.length} processed\`);

      URL BATCH + TRANSFORM PATTERN:
      thinking(\`Fetching \${urls.length} URLs\`);
      const responses = UrlFetchApp.fetchAll(urls.map(u => ({url: u, muteHttpExceptions: true})));
      const summary = responses.map(r => ({id: JSON.parse(r.getContentText()).id})); // Extract only needed
      thinking(\`Complete | \${summary.length} fetched\`);
      return summary; // Lean payload, not full responses

    - log(msg): Server-side diagnostics (Logger.log wrapper, developer-facing, no throttle)

      USAGE: log('[TAG] message') for structured server logs
      Tags: [FETCH], [READ], [FILTER], [JOIN], [CALC], [WRITE], [RESULT], [COMPLETE], [ERROR]

      vs thinking(): thinking() = user-facing progress (rate-limited). log() = developer diagnostics.

    PREFERRED PATTERN - Fetch and Write in One Call:
    Use exec to call fetch and directly manipulate results into cells.
    This is MORE EFFICIENT than calling fetch separately then exec.

    Example - Fetch API data and write to sheet:
    const response = fetch({ url: 'https://api.example.com/data', responseHeadersOnly: false });
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    sheet.getRange('A1').setValue(response.body.temperature);
    return 'Data written to A1';

    Example - Multiple sources with processing:
    const weather = fetch({ url: 'https://api.weather.com/current', responseHeadersOnly: false });
    const forecast = fetch({ url: 'https://api.weather.com/forecast', responseHeadersOnly: false });
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    sheet.getRange('A1').setValue(weather.body.temp);
    sheet.getRange('B1').setValue(forecast.body.temp);
    return 'Weather data written';

    Example - Read cell value and fetch data:
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    const city = sheet.getRange('A1').getValue();
    const url = 'https://api.weather.com/current?city=' + encodeURIComponent(city);
    const response = fetch({ url: url, responseHeadersOnly: false });
    sheet.getRange('B1').setValue(response.body.temperature);
    return 'Temperature written to B1';lue

  SPREADSHEET EXAMPLES:

  1. Get active range values (reads data from selected cells):
  const values = SpreadsheetApp.getActiveRange().getValues();
  return {
    values: values,
    numRows: values.length,
    numCols: values[0]?.length || 0
  };

  2. Set values in active range (writes data to selected cells):
  const jsonValues = '[["Value 1", "Value 2"], ["Value 3", "Value 4"]]';
  SpreadsheetApp.getActiveRange().setValues(JSON.parse(jsonValues));
  return 'Values updated successfully';

  3. Get formulas from entire sheet (reads all formulas):
  const formulas = SpreadsheetApp.getActiveSpreadsheet()
    .getActiveSheet()
    .getDataRange()
    .getFormulas();
  return {
    formulas: formulas,
    numRows: formulas.length,
    numCols: formulas[0]?.length || 0
  };

  4. Set formulas in active range (writes formulas to selected cells):
  const formulas = '[["=A1+B1", "=SUM(A:A)"], ["=TODAY()", "=NOW()"]]';
  SpreadsheetApp.getActiveRange().setFormulas(JSON.parse(formulas));
  return 'Formulas set successfully';

  5. Fetch specific sheet and range by name:
  const sheetName = 'Sheet1';
  const values = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(sheetName)
    .getRange(1, 1, 3, 2)  // row, col, numRows, numCols
    .getValues();
  return {
    sheet: sheetName,
    range: 'A1:B3',
    values: values
  };

  6. Get spreadsheet information:
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    name: ss.getName(),
    id: ss.getId(),
    url: ss.getUrl(),
    activeSheetName: ss.getActiveSheet().getName(),
    sheetCount: ss.getSheets().length
  };

  OTHER COMMON OPERATIONS:

  Get all sheets:
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(s => s.getName());

  Get named ranges:
  return SpreadsheetApp.getActiveSpreadsheet().getNamedRanges().map(nr => ({
    name: nr.getName(),
    range: nr.getRange().getA1Notation()
  }));

  Select a specific range (makes it the active range):
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  sheet.getRange('A1:C10').activate();
  return 'Range A1:C10 is now selected';

  Store/retrieve state (survives across tool calls in same conversation):
  toolState.lastSelection = SpreadsheetApp.getActiveRange().getA1Notation();
  return toolState;

  Access previous tool's result:
  const webData = toolState.previousResult;  // from fetch or other tool
  const processed = webData.split('\n').filter(x => x.includes('keyword'));
  return processed;`,
        input_schema: {
          type: "object",
          properties: {
            jsCode: { 
              type: "string", 
              description: "JavaScript code to execute. Return values are JSON-serialized." 
            }
          },
          required: ["jsCode"]
        }
      };
    }
    
    /**
     * Execute JavaScript code with SpreadsheetApp context
     * @param {Object} input - Tool input with jsCode
     * @param {Object} context - Execution context (depth, toolState, etc.)
     * @returns {Object} Result object with success/error, result/error fields
     */
    execute(input, context = {}) {
      const { jsCode } = input;
      const toolState = context.toolState || {};
      const toolRegistry = context.toolRegistry;
      
      try {
        // Create named wrapper functions for each available tool
        let fetch, knowledge, askllm, analyzeUrl;
        
        if (toolRegistry) {
          const enabledTools = toolRegistry.getEnabledToolNames();
          
          enabledTools.forEach(toolName => {
            // Skip exec to prevent infinite recursion
            if (toolName === 'exec') return;
            
            // Create wrapper function that calls through registry
            const wrapperFn = function(toolInput) {
              const result = toolRegistry.executeToolCall(
                toolName, 
                toolInput, 
                {
                  ...context,
                  depth: (context.depth || 0) + 1  // Increment depth
                }
              );
              
              // Return the result directly (not wrapped)
              return result.result || result;
            };
            
            // Assign to specific variable name
            if (toolName === 'fetch') fetch = wrapperFn;
            else if (toolName === 'knowledge') knowledge = wrapperFn;
            else if (toolName === 'askllm') askllm = wrapperFn;
            else if (toolName === 'analyzeUrl') analyzeUrl = wrapperFn;
          });
        }
        
        // [THINK] context.think → thinking() in exec code → QueueManager → sidebar
        const contextThink = context.think || (() => {});

        // thinking() - logs with [THINKING] tag AND sends to UI
        const thinking = (msg) => {
          const message = typeof msg === 'object' ? JSON.stringify(msg) : `${msg}`;
          Logger.log(`[THINKING] ${message}`);
          contextThink(message);
        };
        
        // log() function for server-side diagnostics (Logger.log wrapper)
        const log = (msg) => {
          try {
            const message = msg == null ? '' :
              typeof msg === 'string' ? msg : JSON.stringify(msg);
            Logger.log(message);
          } catch (e) {
            Logger.log('[log error] ' + String(msg));
          }
        };
        
        // Create function with explicitly named parameters
        const fn = new Function(
          'SpreadsheetApp', 
          'ScriptApp', 
          'toolState',
          'fetch',
          'knowledge',
          'askllm',
          'analyzeUrl',
          'thinking',
          'log',
          `return (function() { ${jsCode} })();`
        );
        
        // Execute with explicitly passed arguments
        const result = fn(
          SpreadsheetApp, 
          ScriptApp, 
          toolState,
          fetch,
          knowledge,
          askllm,
          analyzeUrl,
          thinking,
          log
        );
        
        // Return result along with updated toolState
        // [SENSITIVE] logging is handled by ClaudeConversation
        return this._successResult(result, { toolState: toolState });
      } catch (error) {
        return this._errorResult(error.toString(), error);
      }
    }
  }

  module.exports = SpreadsheetToolHandler;
}

__defineModule__(_main);