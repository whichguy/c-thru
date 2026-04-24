// then-later/core/TriggerManager.gs - Ephemeral trigger lifecycle management

function _main(module, exports, log) {

  /**
   * Manages the ephemeral trigger pattern:
   * 1. Trigger starts and immediately deletes itself (frees quota slot)
   * 2. Processes jobs
   * 3. Conditionally recreates trigger if more work remains
   */
  class TriggerManager {
    constructor(config = {}) {
      this.maxTriggers = config.maxTriggers || 15;
      this.activeTriggers = new Set();
    }

    createProcessingTrigger(options) {
      log('Creating processing trigger | ' + JSON.stringify({ options }));

      if (!options) {
        options = { scheduleType: 'after', offsetMs: 1000 };
      }

      try {
        const currentTriggers = ScriptApp.getProjectTriggers()
          .filter(t => t.getHandlerFunction() === 'processQueue');

        if (currentTriggers.length >= this.maxTriggers) {
          log('[W] Trigger limit reached | ' + JSON.stringify({ current: currentTriggers.length, max: this.maxTriggers }));
          return null;
        }

        let builder = ScriptApp.newTrigger('processQueue').timeBased();

        switch (options.scheduleType) {
          case 'once': {
            const targetTime = typeof options.isoTime === 'string' ?
              new Date(options.isoTime) :
              options.isoTime;
            builder = builder.at(targetTime);
            break;
          }

          case 'weekly':
            builder = builder.after(1000);
            log('Using immediate trigger for weekly scheduled job');
            break;

          case 'after':
            builder = builder.after(options.offsetMs || 1000);
            break;

          default:
            builder = builder.after(1000);
            break;
        }

        const trigger = builder.create();
        log('Created new trigger | ' + JSON.stringify({ scheduleType: options.scheduleType, triggerId: trigger.getUniqueId() }));

        return trigger;
      } catch (err) {
        log('[E] Trigger creation failed: ' + err.message);
        return null;
      }
    }

    deleteCurrentTrigger(triggerId) {
      log('Attempting to delete current trigger | ' + JSON.stringify({ triggerId }));

      try {
        ScriptApp.getProjectTriggers().forEach(trigger => {
          if (trigger.getUniqueId() === triggerId) {
            ScriptApp.deleteTrigger(trigger);
            this.activeTriggers.delete(triggerId);
            log('Deleted current trigger | ' + JSON.stringify({ triggerId }));
          }
        });
      } catch (e) {
        log('[E] Trigger deletion failed: ' + e.message + ' | ' + JSON.stringify({ triggerId }));
      }
    }

    createWatchdogTrigger() {
      log('Creating watchdog trigger');

      const existingWatchdog = ScriptApp.getProjectTriggers()
        .some(t => t.getHandlerFunction() === 'watchdogCleanup');

      if (!existingWatchdog) {
        ScriptApp.newTrigger('watchdogCleanup')
          .timeBased()
          .everyHours(6)
          .create();

        log('Created watchdog trigger');
      } else {
        log('Watchdog trigger already exists');
      }
    }

    hasActiveTriggers() {
      const count = ScriptApp.getProjectTriggers()
        .filter(t => t.getHandlerFunction() === 'processQueue')
        .length;

      return count > 0;
    }

    getActiveTriggerCount() {
      return ScriptApp.getProjectTriggers()
        .filter(t => t.getHandlerFunction() === 'processQueue')
        .length;
    }

    registerTrigger(triggerId) {
      this.activeTriggers.add(triggerId);
      log('Registered trigger | ' + JSON.stringify({ triggerId }));
    }

    unregisterTrigger(triggerId) {
      this.activeTriggers.delete(triggerId);
      log('Unregistered trigger | ' + JSON.stringify({ triggerId }));
    }
  }

  module.exports = { TriggerManager };
}

__defineModule__(_main);
