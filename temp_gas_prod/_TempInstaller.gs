// Temporary file — delete after running installAutoOpenTrigger()
function installAutoOpenTrigger() {
  ScriptApp.newTrigger('autoOpenSidebarOnOpen')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onOpen()
    .create();
  Logger.log('autoOpenSidebarOnOpen trigger installed successfully');
}