function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  module.exports = {
    name: 'get_sheet_info',
    description: 'Get metadata about the active spreadsheet: sheet names, dimensions, headers, named ranges.',
    input_schema: { type: 'object', properties: {} },
    execute: (_input) => {
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getActiveSheet();
        const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
        const headers = (lastRow > 0 && lastCol > 0)
          ? sheet.getRange(1, 1, 1, Math.min(lastCol, 20)).getValues()[0] : [];
        const sheets = ss.getSheets().map(s => ({
          name: s.getName(),
          rows: s.getLastRow(),
          cols: s.getLastColumn()
        }));
        const namedRanges = ss.getNamedRanges().map(r => ({
          name: r.getName(),
          range: r.getRange().getA1Notation()
        }));
        return {
          success: true,
          result: { activeSheet: sheet.getName(), rows: lastRow, cols: lastCol, headers, sheets, namedRanges }
        };
      } catch (e) {
        log(`[GetSheetInfoTool] Error: ${e.message}`);
        return { success: false, error: `get_sheet_info failed: ${e.message}` };
      }
    }
  };
}

__defineModule__(_main);