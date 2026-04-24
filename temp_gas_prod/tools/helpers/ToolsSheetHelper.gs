function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Helper module to update _Tools sheet cells
   */

  function updateToolImplementation(row, content) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('_Tools');
    if (!sheet) {
      return { success: false, error: '_Tools sheet not found' };
    }
    // Column D is implementation (column 4)
    sheet.getRange(row, 4).setValue(content);
    return { success: true, row, updatedAt: new Date().toISOString() };
  }

  module.exports = { updateToolImplementation };
}

__defineModule__(_main);