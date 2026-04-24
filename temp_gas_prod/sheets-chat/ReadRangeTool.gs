function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  module.exports = {
    name: 'read_range',
    description: 'Read cell values or formulas from a spreadsheet range. Use when you need to examine actual data. Limited to 5,000 cells per call.',
    input_schema: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'A1 notation e.g. "Sheet1!A1:D100" or a named range' },
        includeFormulas: { type: 'boolean', default: false }
      },
      required: ['range']
    },
    execute: (input) => {
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const range = ss.getRangeByName(input.range) ||
          (input.range.includes('!') ? ss.getRange(input.range) : ss.getActiveSheet().getRange(input.range));
        const rows = range.getNumRows(), cols = range.getNumColumns();
        if (rows * cols > 5000) return { success: false, error: `Range too large (${rows * cols} cells). Limit is 5,000.` };
        const values = input.includeFormulas ? range.getFormulas() : range.getValues();
        return {
          success: true,
          result: {
            values,
            rows,
            cols,
            rangeA1: range.getA1Notation(),
            note: input.includeFormulas ? 'Non-formula cells show as empty string' : undefined
          }
        };
      } catch (e) {
        log(`[ReadRangeTool] Error: ${e.message}`);
        return { success: false, error: `Failed to read range "${input.range}": ${e.message}` };
      }
    }
  };
}

__defineModule__(_main);