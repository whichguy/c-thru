// sheets-chat/TaskRegistry.gs - Whitelist of schedulable background tasks

function _main(module = globalThis.__getCurrentModule(), exports = module.exports, log = globalThis.__getModuleLogFunction?.(module) || (() => {})) {

  /**
   * Registry of tasks Claude can schedule as background jobs.
   *
   * Each functionPath must be registered in __global__ on its module so that
   * JobExecutor.resolveFunction() can find it via globalThis[functionPath].
   */
  const REGISTRY = {
    run_ambient_analysis: {
      task_key: 'run_ambient_analysis',
      functionPath: 'scheduledAmbientAnalysis',
      description: 'Run a full sheet analysis in the background'
    },
    export_sheet_to_drive: {
      task_key: 'export_sheet_to_drive',
      functionPath: 'scheduledExportSheetToDrive',
      description: 'Export active sheet to Google Drive'
    }
  };

  function getTask(key) {
    return REGISTRY[key] || null;
  }

  function listTasks() {
    return Object.values(REGISTRY);
  }

  module.exports = { REGISTRY, getTask, listTasks };
}

__defineModule__(_main);
