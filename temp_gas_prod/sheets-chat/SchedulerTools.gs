// sheets-chat/SchedulerTools.gs - Five Claude tools for async background task scheduling

function _main(module, exports, log) {

  /**
   * Derives current Drive-based status for a job by scanning folder filenames.
   * Filenames encode jobId: STATE-{jobId}-{desc}.json
   */
  function _deriveJobStatus(jobId, scheduler) {
    try { scheduler.driveStorage.initialize(); } catch (e) { /* already initialized or Drive unavailable */ }

    const checks = [
      { type: 'results', status: 'completed' },
      { type: 'deadLetters', status: 'failed' },
      { type: 'locks', status: 'running' },
      { type: 'jobs', status: 'pending' }
    ];

    for (const { type, status } of checks) {
      try {
        const folder = scheduler.driveStorage.getFolder(type);
        const files = folder.getFiles();
        while (files.hasNext()) {
          if (files.next().getName().includes(jobId)) return status;
        }
      } catch (e) {
        // folder not initialized yet, skip
      }
    }

    return 'unknown';
  }

  const ScheduleTaskTool = {
    name: 'schedule_task',
    description: 'Schedule a background task to run asynchronously via GAS triggers. Provide functionPath (direct module path) or task_key (pre-registered task). Returns a jobId.',
    input_schema: {
      type: 'object',
      properties: {
        functionPath: {
          type: 'string',
          description: 'Direct module function path (e.g. "ScriptRunner.runScript"). Must contain a dot separator and use only word characters.'
        },
        args: {
          type: 'array',
          description: 'Arguments to pass to the function (used with functionPath).'
        },
        delayMs: {
          type: 'number',
          description: 'Milliseconds before execution (used with functionPath).',
          default: 0
        },
        task_key: {
          type: 'string',
          enum: ['run_ambient_analysis', 'export_sheet_to_drive'],
          description: 'Pre-registered task to run (mutually exclusive with functionPath).'
        },
        description: {
          type: 'string',
          description: 'Human-readable label shown in completion notifications.'
        }
      }
    },
    execute: (input) => {
      try {
        // functionPath branch: validate and delegate to Entrypoints.scheduleTask
        if (input.functionPath !== undefined || !input.task_key) {
          const fp = input.functionPath;
          if (!fp || typeof fp !== 'string') {
            return { success: false, error: 'Invalid functionPath' };
          }
          if (!/^[\w$]+\.[\w$]/.test(fp)) {
            return { success: false, error: 'Invalid functionPath' };
          }
          const result = require('then-later/Entrypoints').scheduleTask(fp, input.args || [], input.delayMs || 0);
          return { success: true, result };
        }

        // task_key branch (legacy pre-registered tasks)
        const { JobScheduler } = require('then-later/core/JobScheduler');
        const { getTask } = require('sheets-chat/TaskRegistry');

        const task = getTask(input.task_key);
        if (!task) {
          return { success: false, error: `Unknown task_key: "${input.task_key}". Use list_scheduled_tasks to see valid keys.` };
        }

        const description = input.description || task.description;
        const scheduler = new JobScheduler({ maxTriggers: 13 });

        // Ensure Drive folder structure exists (idempotent)
        try { scheduler.driveStorage.initialize(); } catch (e) { /* already exists */ }

        // Capture jobId before schedule() so we can store it as tag
        const builder = scheduler.create(task.functionPath).withOptions({ description: description });
        const jobId = builder.job.jobId;
        builder.job.metadata.tags = [jobId];
        builder.schedule();

        PropertiesService.getScriptProperties().setProperty(
          'SCHEDULER_JOB_' + jobId,
          JSON.stringify({
            task_key: input.task_key,
            description: description,
            scheduledAt: new Date().toISOString(),
            functionPath: task.functionPath,
            tag: jobId
          })
        );

        return { success: true, result: { jobId, task_key: input.task_key, description } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  };

  const ListScheduledTasksTool = {
    name: 'list_scheduled_tasks',
    description: 'List all tracked background tasks with their current status (pending/running/completed/failed/unknown). Use this to discover active jobIds before calling check_task_status or get_task_result.',
    input_schema: { type: 'object', properties: {} },
    execute: (input) => {
      try {
        const { JobScheduler } = require('then-later/core/JobScheduler');
        const allProps = PropertiesService.getScriptProperties().getProperties();
        const jobEntries = Object.entries(allProps)
          .filter(([key]) => key.startsWith('SCHEDULER_JOB_'));

        if (jobEntries.length === 0) {
          return { success: true, result: [] };
        }

        const scheduler = new JobScheduler({ maxTriggers: 13 });
        const tasks = [];

        for (const [key, value] of jobEntries) {
          try {
            const meta = JSON.parse(value);
            const jobId = key.substring('SCHEDULER_JOB_'.length);
            const status = _deriveJobStatus(jobId, scheduler);
            tasks.push({
              jobId,
              task_key: meta.task_key,
              description: meta.description,
              status,
              scheduledAt: meta.scheduledAt
            });
          } catch (e) {
            // Corrupt entry, skip
          }
        }

        // Sort by scheduledAt descending (newest first)
        tasks.sort((a, b) => (b.scheduledAt || '').localeCompare(a.scheduledAt || ''));

        return { success: true, result: tasks };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  };

  const CheckTaskStatusTool = {
    name: 'check_task_status',
    description: 'Check the current status of a specific background task. Status: pending (queued), running (executing), completed (result ready), failed (see error), unknown (not tracked).',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The jobId returned by schedule_task' }
      },
      required: ['job_id']
    },
    execute: (input) => {
      try {
        const { JobScheduler } = require('then-later/core/JobScheduler');
        const metaStr = PropertiesService.getScriptProperties().getProperty('SCHEDULER_JOB_' + input.job_id);

        if (!metaStr) {
          return { success: true, result: { jobId: input.job_id, status: 'unknown' } };
        }

        const meta = JSON.parse(metaStr);
        const scheduler = new JobScheduler({ maxTriggers: 13 });
        const status = _deriveJobStatus(input.job_id, scheduler);

        return {
          success: true,
          result: {
            jobId: input.job_id,
            task_key: meta.task_key,
            description: meta.description,
            status,
            scheduledAt: meta.scheduledAt
          }
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  };

  const GetTaskResultTool = {
    name: 'get_task_result',
    description: 'Retrieve and consume the result of a completed background task. One-time operation — result deleted from Drive after retrieval. Only call after check_task_status returns completed.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The jobId of the completed task' }
      },
      required: ['job_id']
    },
    execute: (input) => {
      try {
        const { JobScheduler } = require('then-later/core/JobScheduler');
        const props = PropertiesService.getScriptProperties();
        const metaStr = props.getProperty('SCHEDULER_JOB_' + input.job_id);

        if (!metaStr) {
          return { success: false, error: `No tracked job found for jobId: ${input.job_id}` };
        }

        const meta = JSON.parse(metaStr);
        const scheduler = new JobScheduler({ maxTriggers: 13 });

        const [results, metadata] = scheduler.pickup(meta.functionPath, meta.tag);

        // Clean up tracking keys
        props.deleteProperty('SCHEDULER_JOB_' + input.job_id);
        props.deleteProperty('SCHEDULER_NOTIFY_' + input.job_id);

        return {
          success: true,
          result: {
            output: results,
            duration: metadata && metadata.duration,
            status: (metadata && metadata.success) ? 'completed' : 'failed'
          }
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  };

  const CancelTaskTool = {
    name: 'cancel_task',
    description: 'Cancel a pending or running background task. Pending tasks are removed immediately; running tasks are flagged for cancellation (may not stop mid-execution).',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The jobId to cancel' }
      },
      required: ['job_id']
    },
    execute: (input) => {
      try {
        if (!input.job_id || typeof input.job_id !== 'string') {
          return { success: false, error: 'jobId is required' };
        }
        const { JobScheduler } = require('then-later/core/JobScheduler');
        const props = PropertiesService.getScriptProperties();
        const metaStr = props.getProperty('SCHEDULER_JOB_' + input.job_id);

        if (!metaStr) {
          return { success: false, error: `No tracked job found for jobId: ${input.job_id}` };
        }

        const scheduler = new JobScheduler({ maxTriggers: 13 });
        try { scheduler.driveStorage.initialize(); } catch (e) { /* already initialized */ }

        // Early return if already completed — preserve keys for get_task_result
        for (const type of ['results', 'deadLetters']) {
          try {
            const folder = scheduler.driveStorage.getFolder(type);
            const files = folder.getFiles();
            while (files.hasNext()) {
              if (files.next().getName().includes(input.job_id)) {
                return { success: true, result: { jobId: input.job_id, cancelled: false,
                  message: 'Task already completed or failed — use get_task_result to retrieve output.' } };
              }
            }
          } catch (e) { /* folder not accessible */ }
        }

        let cancelled = false;
        let message = '';

        // Try to remove from Jobs/ folder (pending state)
        try {
          const jobsFolder = scheduler.driveStorage.getFolder('jobs');
          const files = jobsFolder.getFiles();
          while (files.hasNext()) {
            const file = files.next();
            if (file.getName().includes(input.job_id)) {
              file.setTrashed(true);
              cancelled = true;
              message = 'Pending task removed from queue.';
              break;
            }
          }
        } catch (e) { /* folder not accessible */ }

        // If not pending, check ActiveJobsRegistry to cancel running job
        if (!cancelled) {
          const registryStr = props.getProperty('ActiveJobsRegistry') || '{}';
          const registry = JSON.parse(registryStr);

          for (const [triggerId, record] of Object.entries(registry)) {
            if (record.jobFileName && record.jobFileName.includes(input.job_id)) {
              scheduler.requestCancellation(triggerId);
              cancelled = true;
              message = 'Cancellation requested for running task (may not stop mid-step).';
              break;
            }
          }
        }

        if (!cancelled) {
          message = 'Task not found in active queue (may have already completed or been cleaned up).';
        }

        // Always clean up tracking keys for non-completed jobs (pending/running/ghost)
        props.deleteProperty('SCHEDULER_JOB_' + input.job_id);
        props.deleteProperty('SCHEDULER_NOTIFY_' + input.job_id);

        return { success: true, result: { jobId: input.job_id, cancelled, message } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  };

  function Sched() { return require('then-later/Entrypoints'); }

  // Delegates to Entrypoints.scheduleScript — queues arbitrary JS code via ScriptRunner.runScript
  const ScheduleScriptTool = {
    name: 'schedule_script',
    description: 'Schedule an arbitrary JavaScript code string to run asynchronously in GAS context. The code has full API access (SpreadsheetApp, DriveApp, etc.) and may use `return` to produce a value. Returns a jobId — check with check_task_status or browse results with list_script_results. SECURITY: confirm with user before scheduling code that writes or deletes data.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute (max 50,000 chars). Has full GAS API access. May use `return` to produce a value. Syntax is checked before queuing.'
        },
        description: {
          type: 'string',
          description: 'Label shown in list_script_results (max 50 chars)'
        },
        delayMs: {
          type: 'number',
          description: 'Milliseconds before first run (default 0 = immediate)',
          default: 0
        },
        repeatIntervalMs: {
          type: 'number',
          description: 'Milliseconds between repeats. Omit for one-shot. Must be > 0 if provided.',
          examples: [60000, 3600000, 86400000]
        },
        repeatCount: {
          type: 'number',
          description: 'Number of times to repeat. Omit for infinite when repeatIntervalMs is set. Must be a positive integer.'
        },
        weeklyDays: {
          type: 'array',
          items: { type: 'number' },
          description: 'Days of week to run [0=Sun, 1=Mon, ..., 6=Sat]. If set, job only executes on those days.'
        }
      },
      required: ['code']
    },
    execute: (input) => {
      try {
        const { code, description, delayMs, repeatIntervalMs, repeatCount, weeklyDays } = input;
        if (!code || typeof code !== 'string') return { success: false, error: 'code is required and must be a string' };
        if (code.length > 50000) return { success: false, error: 'code exceeds 50,000 character limit' };
        if (description !== undefined && (typeof description !== 'string' || description.length > 50)) return { success: false, error: 'description must be a string with max 50 characters' };
        if (delayMs !== undefined && (typeof delayMs !== 'number' || delayMs < 0)) return { success: false, error: 'delayMs must be a non-negative number' };
        if (repeatIntervalMs !== undefined && (typeof repeatIntervalMs !== 'number' || repeatIntervalMs <= 0)) return { success: false, error: 'repeatIntervalMs must be > 0' };
        if (repeatCount !== undefined && (typeof repeatCount !== 'number' || !Number.isInteger(repeatCount) || repeatCount < 1)) return { success: false, error: 'repeatCount must be a positive integer' };
        if (weeklyDays !== undefined && (!Array.isArray(weeklyDays) || weeklyDays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return { success: false, error: 'weeklyDays must be an array of integers 0-6' };
        const result = Sched().scheduleScript(code, { description, delayMs, repeatIntervalMs, repeatCount, weeklyDays });
        return { success: true, result };
      } catch (e) {
        log('[E] ScheduleScriptTool failed: ' + e.message);
        return { success: false, error: e.message };
      }
    }
  };

  // Delegates to Entrypoints.rescheduleTask — cancel+recreate with new timing; issues a NEW jobId
  const RescheduleTaskTool = {
    name: 'reschedule_task',
    description: 'Reschedule a pending script job (created by schedule_script) with new timing options. Cancels the old job and creates a new one. IMPORTANT: Returns a NEW jobId — discard the old jobId and use the new one for all future operations. Description is automatically inherited from the original job — it cannot be changed on reschedule.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Short job ID from schedule_script (the old ID — will be replaced)' },
        delayMs: { type: 'number', description: 'New delay before first run in ms' },
        repeatIntervalMs: { type: 'number', description: 'New repeat interval in ms (> 0 if provided)' },
        repeatCount: { type: 'number', description: 'New repeat count (positive integer)' },
        weeklyDays: { type: 'array', items: { type: 'number' }, description: 'New weekly days [0-6]' }
      },
      required: ['jobId']
    },
    execute: (input) => {
      try {
        const { jobId, delayMs, repeatIntervalMs, repeatCount, weeklyDays } = input;
        if (!jobId || typeof jobId !== 'string') return { success: false, error: 'jobId is required' };
        if (delayMs !== undefined && (typeof delayMs !== 'number' || delayMs < 0)) return { success: false, error: 'delayMs must be a non-negative number' };
        if (repeatIntervalMs !== undefined && (typeof repeatIntervalMs !== 'number' || repeatIntervalMs <= 0)) return { success: false, error: 'repeatIntervalMs must be > 0' };
        if (repeatCount !== undefined && (typeof repeatCount !== 'number' || !Number.isInteger(repeatCount) || repeatCount < 1)) return { success: false, error: 'repeatCount must be a positive integer' };
        if (weeklyDays !== undefined && (!Array.isArray(weeklyDays) || weeklyDays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return { success: false, error: 'weeklyDays must be an array of integers 0-6' };
        const result = Sched().rescheduleTask(jobId, { delayMs, repeatIntervalMs, repeatCount, weeklyDays });
        return { success: true, result };
      } catch (e) {
        log('[E] RescheduleTaskTool failed: ' + e.message);
        return { success: false, error: e.message };
      }
    }
  };

  // Delegates to Entrypoints.listScriptResults — lists completed/failed/cancelled script runs
  const ListScriptResultsTool = {
    name: 'list_script_results',
    description: 'List completed and failed script job results from the then-later Drive store. Shows up to 50 most recent results (newest first). Includes firedAt time, durationMs, return value, and error if failed. Cancelled pending jobs do NOT appear here (they are trashed). Use check_task_status(jobId) for polling a specific pending job.',
    input_schema: { type: 'object', properties: {} },
    execute: (_input) => {
      try {
        const result = Sched().listScriptResults();
        return { success: true, result };
      } catch (e) {
        log('[E] ListScriptResultsTool failed: ' + e.message);
        return { success: false, error: e.message };
      }
    }
  };

  // Delegates to Entrypoints.getScriptResult — retrieve completed/failed result by specific jobId
  const GetScriptResultTool = {
    name: 'get_script_result',
    description: 'Retrieve the result of a specific completed or failed script job by jobId. Returns the return value, firedAt time, durationMs, and error if failed. Returns null if the job is still pending or running — use check_task_status to poll pending jobs. NOTE: for recurring jobs (created with repeatIntervalMs), each run produces a new jobId; use list_script_results to see all runs.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Short job ID returned by schedule_script or reschedule_task' }
      },
      required: ['jobId']
    },
    execute: (input) => {
      try {
        const { jobId } = input;
        if (!jobId || typeof jobId !== 'string') return { success: false, error: 'jobId is required' };
        const result = Sched().getScriptResult(jobId);
        return { success: true, result };
      } catch (e) {
        log('[E] GetScriptResultTool failed: ' + e.message);
        return { success: false, error: e.message };
      }
    }
  };

  module.exports = {
    ScheduleTaskTool,
    ListScheduledTasksTool,
    CheckTaskStatusTool,
    GetTaskResultTool,
    CancelTaskTool,
    ScheduleScriptTool,
    RescheduleTaskTool,
    ListScriptResultsTool,
    GetScriptResultTool
  };
}

__defineModule__(_main);
