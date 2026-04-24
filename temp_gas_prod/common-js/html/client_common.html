<script>
    window.StateRenderer = {
      filterText: '',
      filterMode: 'names', // 'names' or 'values'
      _filterTimeout: null,

      getTypeEmoji: function(value) {
        const type = typeof value;
        if (value === null) return '⊘';
        if (value === undefined) return '∅';
        if (Array.isArray(value)) return '[]';
        if (type === 'object') {
          if (value instanceof Map) return 'ᴍ';
          if (value instanceof Set) return 'ꜱ';
          if (value instanceof Date) return 'ᴛ';
          return '{}';
        }
        if (type === 'string') return '""';
        if (type === 'number') return '#';
        if (type === 'boolean') return value ? '✓' : '✗';
        if (type === 'function') return 'ƒ';
        return '?';
      },

      getTypeClass: function(value) {
        const type = typeof value;
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (Array.isArray(value)) return 'array';
        if (type === 'object') return 'object';
        return type;
      },

      formatValue: function(value, maxLength = 40) {
        const type = typeof value;
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (type === 'string') return '"' + (value.length > maxLength ? value.substring(0, maxLength) + '...' : value) + '"';
        if (type === 'function') return 'ƒ()';
        if (Array.isArray(value)) return '[' + value.length + ']';
        if (type === 'object') {
          const keys = Object.keys(value);
          return '{' + keys.length + '}';
        }
        return String(value);
      },

      isExpandable: function(value) {
        return value !== null && value !== undefined && (typeof value === 'object' || Array.isArray(value));
      },

      matchesFilter: function(key, value, path = []) {
        if (!this.filterText) return { matches: true, path: null };

        const searchText = this.filterText.toLowerCase();
        const fullPath = [...path, key];

        // Search in names
        if (this.filterMode === 'names') {
          if (key.toLowerCase().includes(searchText)) {
            return { matches: true, path: fullPath, matchedAt: 'key' };
          }
        } else {
          // Search in values
          const valueStr = this.formatValue(value).toLowerCase();
          if (valueStr.includes(searchText)) {
            return { matches: true, path: fullPath, matchedAt: 'value' };
          }
        }

        // Search in nested objects
        if (this.isExpandable(value)) {
          const entries = Array.isArray(value)
            ? value.map((v, i) => [String(i), v])
            : Object.entries(value);

          for (const [nestedKey, nestedValue] of entries) {
            const nestedResult = this.matchesFilter(nestedKey, nestedValue, fullPath);
            if (nestedResult.matches) {
              return nestedResult;
            }
          }
        }

        return { matches: false, path: null };
      },

      highlightMatch: function(text) {
        if (!this.filterText) return text;
        
        // Create container for safe text rendering (XSS prevention)
        const $container = $('<span>');
        const searchText = this.filterText.toLowerCase();
        const lowerText = text.toLowerCase();
        
        let lastIndex = 0;
        let index = lowerText.indexOf(searchText);
        
        while (index !== -1) {
          // Add text before match
          if (index > lastIndex) {
            $container.append(document.createTextNode(text.substring(lastIndex, index)));
          }
          
          // Add highlighted match
          $container.append(
            $('<span class="highlight-match">').text(text.substring(index, index + searchText.length))
          );
          
          lastIndex = index + searchText.length;
          index = lowerText.indexOf(searchText, lastIndex);
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
          $container.append(document.createTextNode(text.substring(lastIndex)));
        }
        
        return $container;
      },

      renderTreeItem: function(key, value, path = [], forceShow = false, depth = 0) {
        const MAX_DEPTH = 20;  // Prevent stack overflow
        
        // Depth limit check (stack overflow protection)
        if (depth >= MAX_DEPTH) {
          const $item = $('<div class="state-tree-item">');
          const $header = $('<div class="state-tree-header">');
          $header.append(
            $('<span class="tree-expand-icon leaf">').text('·'),
            $('<span class="state-key">').text(key),
            $('<span class="state-value">').text('(max depth reached)'),
            $('<span class="state-emoji">').text('⚠️')
          );
          $item.append($header);
          return $item;
        }
        const filterResult = this.matchesFilter(key, value, path.slice(0, -1));

        if (!forceShow && !filterResult.matches) {
          return null;
        }

        const $item = $('<div class="state-tree-item">');
        const $header = $('<div class="state-tree-header">');

        const isExpandable = this.isExpandable(value);
        const expandIcon = isExpandable ? '▶' : '·';
        const $expandIcon = $('<span class="tree-expand-icon' + (isExpandable ? '' : ' leaf') + '">').text(expandIcon);

        const emoji = this.getTypeEmoji(value);
        const $emoji = $('<span class="state-emoji">').text(emoji);

        const $key = $('<span class="state-key">');
        if (this.filterMode === 'names' && this.filterText) {
          $key.append(this.highlightMatch(key));
        } else {
          $key.text(key);
        }

        const typeClass = this.getTypeClass(value);
        const displayValue = this.formatValue(value);
        const $value = $('<span>').addClass('state-value').addClass(typeClass);
        if (this.filterMode === 'values' && this.filterText) {
          $value.append(this.highlightMatch(displayValue));
        } else {
          $value.text(displayValue);
        }

        $header.append($expandIcon, $key, $value, $emoji);

        // Add path if this is a nested match
        if (filterResult.path && filterResult.path.length > 1 && this.filterText) {
          const pathStr = filterResult.path.slice(0, -1).join(' › ');
          const $path = $('<span class="state-path">').text('(' + pathStr + ')');
          $header.append($path);
        }

        $item.append($header);

        if (isExpandable) {
          const $children = $('<div class="state-tree-children">');
          const entries = Array.isArray(value)
            ? value.map((v, i) => [String(i), v])
            : Object.entries(value);

          entries.forEach(([childKey, childValue]) => {
            const childPath = [...path, childKey];
            const $child = this.renderTreeItem(childKey, childValue, childPath, filterResult.matches, depth + 1);
            if ($child) {
              $children.append($child);
            }
          });

          $item.append($children);

          $header.on('click', function(e) {
            e.stopPropagation();
            $expandIcon.toggleClass('expanded');
            $children.toggleClass('expanded');
          });
        }

        return $item;
      },

      render: function(storage) {
        const $panel = $('#clientStatePanel');
        const keys = Object.keys(storage);

        if (keys.length === 0) {
          $panel.html('<div style="color: var(--text-secondary); font-size: 11px; padding: 8px;">No variables stored</div>');
          return;
        }

        $panel.empty();

        let hasVisibleItems = false;
        keys.forEach((key) => {
          const value = storage[key];
          const $item = this.renderTreeItem(key, value, [key], false);
          if ($item) {
            $panel.append($item);
            hasVisibleItems = true;
          }
        });

        if (!hasVisibleItems && this.filterText) {
          $panel.html('<div style="color: var(--text-secondary); font-size: 11px; padding: 8px;">No matches found</div>');
        }
      }
    };

    window.clientState = {
      storage: {},

      set: function(key, value) {
        this.storage[key] = value;
        window.StateRenderer.render(this.storage);
      },

      get: function(key) {
        return this.storage[key];
      },

      delete: function(key) {
        delete this.storage[key];
        window.StateRenderer.render(this.storage);
      },

      clear: function() {
        this.storage = {};
        window.StateRenderer.render(this.storage);
      },

      run: function(serverCode, clientCommand) {
        const startTime = performance.now();

        return new Promise((resolve, reject) => {
          if (!window.server) {
            const clientTime = (performance.now() - startTime).toFixed(2);
            window.UI.addOutput('Cannot execute: server not available', 'error', null, 'client: ' + clientTime + 'ms');
            reject(new Error('server not available'));
            return;
          }

          window.server.exec_api(null, 'common-js/__mcp_exec', 'exec', serverCode)
            .then(function(response) {
              const clientTime = (performance.now() - startTime).toFixed(2);
              const serverTime = response.execution_time_ms || 0;
              const timing = 'client: ' + clientTime + 'ms, server: ' + serverTime + 'ms';

              // Check if execution succeeded (not just HTTP call)
              if (!response || response.success !== true) {
                const errorMsg = response ? (response.error || response.message || String(response.result) || JSON.stringify(response)) : 'No response';
                window.UI.addOutput(
                  'Error: ' + errorMsg,
                  'error',
                  response ? response.logger_output : null,
                  timing
                );
                reject(new Error(errorMsg));
                return;
              }

              // Execution succeeded - display result without "SUCCESS" text
              const displayResult = typeof response.result === 'object'
                ? JSON.stringify(response.result, null, 2)
                : String(response.result);

              window.UI.addOutput(
                displayResult,
                'success',
                response.logger_output,
                timing
              );

              // Mark result as already displayed to prevent duplicate output
              const wrappedResult = { __runHandled: true, value: response.result };
              resolve(wrappedResult);
            })
            .catch(function(error) {
              const clientTime = (performance.now() - startTime).toFixed(2);
              window.UI.addOutput('Execution failed: ' + error.message, 'error', null, 'client: ' + clientTime + 'ms');
              reject(error);
            });
        });
      },

      inspectAndUpdate: function(statement, result) {
        const assignmentMatch = statement.trim().match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(.+)$/);

        if (assignmentMatch && result !== undefined) {
          const varName = assignmentMatch[1];

          // Prevent overwriting critical globals and built-ins
          const reserved = [
            'window', 'document', 'google', 'clientState', 'run',
            'StateRenderer', 'UI', 'DataLoader', 'CodeExecutor', 'DeploymentManager',
            'jQuery', '$', 'console', 'alert', 'prompt', 'confirm'
          ];
          
          if (reserved.includes(varName)) {
            console.warn('[REPL] Cannot assign to reserved variable: ' + varName);
            window.UI.addOutput(
              '⚠️ Cannot assign to reserved variable: ' + varName,
              'error',
              null,
              null,
              statement
            );
            return;
          }

          if (!statement.includes('==') && !statement.includes('!=')) {
            clientState.storage[varName] = result;
            window.StateRenderer.render(this.storage);
          }
        }
      }
    };

    window.UI = {
      addOutput: function(message, type, serverLogs, timing, command) {
        const $console = $('#console');

        // Echo the command if provided (like a REPL prompt)
        if (command && command.trim()) {
          const $commandEcho = $('<div style="color: var(--text-secondary); font-family: Consolas, Monaco, monospace; font-size: 13px; margin-bottom: 8px; padding: 4px 8px; background: var(--bg-secondary); border-radius: 3px; display: flex; align-items: center; gap: 8px;">');
          const $commandText = $('<span>').text('> ' + command);
          const $replayBtn = $('<button class="replay-btn" style="margin-left: auto;" title="Re-run this command">↻</button>');
          $replayBtn.on('click', function() {
            $('#codeInput').val(command);
            window.CodeExecutor.execute();
          });
          $commandEcho.append($commandText, $replayBtn);
          $console.append($commandEcho);
        }

        const now = new Date();
        const timestamp = '[' + now.getHours().toString().padStart(2, '0') + ':' +
                         now.getMinutes().toString().padStart(2, '0') + ':' +
                         now.getSeconds().toString().padStart(2, '0') + ' ' +
                         (now.getHours() >= 12 ? 'PM' : 'AM') + ']';

        const $container = $('<div>').addClass('output-container ' + type);

        const $header = $('<div class="output-header">' +
          '<span class="timestamp">' + timestamp + '</span>' +
          '</div>');

        const $message = $('<div class="output-message ' + type + '">').text(message);

        const $timing = $('<div class="timing-info">').text(timing || '');

        $container.append($header);
        $container.append($message);
        if (timing) {
          $container.append($timing);
        }

        if (serverLogs && serverLogs.trim()) {
          const logId = 'logs-' + Date.now();

          const $toggle = $('<div class="log-toggle" data-target="' + logId + '">' +
            '<span class="log-arrow">▶</span>' +
            '<span>Server logs</span>' +
            '</div>');

          const $logContent = $('<div class="server-logs hidden" id="' + logId + '">').text(serverLogs);

          $toggle.on('click', function() {
            const targetId = $(this).data('target');
            const $content = $('#' + targetId);
            const $arrow = $(this).find('.log-arrow');

            $content.toggleClass('hidden');
            $arrow.toggleClass('expanded');
          });

          $container.append($toggle);
          $container.append($logContent);
        }

        $console.append($container);

        const isAtBottom = $console[0].scrollHeight - $console.scrollTop() <= $console.outerHeight() + 100;

        if (isAtBottom) {
          $console.scrollTop($console[0].scrollHeight);
        } else {
          $('#scrollHint').addClass('visible');
          setTimeout(function() {
            $('#scrollHint').removeClass('visible');
          }, 2000);
        }
      }
    };

    window.DataLoader = {
      _loadingScriptInfo: false,
      _loadingProcesses: false,
      _loadingLogs: false,
      
      loadScriptInfo: function() {
        if (this._loadingScriptInfo) {
          console.log('[DataLoader] Script info request already in progress, skipping');
          return;
        }
        if (!window.server) {
          console.error('server not available');
          return;
        }

        this._loadingScriptInfo = true;

        window.server.exec_api(null, 'common-js/__mcp_exec', 'getScriptInfo')
          .then(function(info) {
            window.DataLoader._loadingScriptInfo = false;
            if (info && info.scriptId) {
              $('#scriptId').text(info.scriptId);
              $('#scriptName').text(info.projectName || 'Unknown');
            }
          })
          .catch(function(error) {
            window.DataLoader._loadingScriptInfo = false;
            console.error('Failed to load script info:', error);
            $('#scriptId').text('Error loading');
            $('#scriptName').text('Error loading');
          });
      },

      loadProcesses: function() {
        if (this._loadingProcesses) {
          console.log('[DataLoader] Processes request already in progress, skipping');
          return;
        }
        
        const $processes = $('#processesList');
        $processes.html('<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">Loading processes...</div>');

        if (!window.server) {
          $processes.html('<div style="padding: 8px; color: var(--error-red); font-size: 11px;">server not available</div>');
          return;
        }

        this._loadingProcesses = true;

        window.server.exec_api(null, 'common-js/__mcp_exec', 'getRecentProcesses')
          .then(function(response) {
            window.DataLoader._loadingProcesses = false;
            if (!response || !response.success) {
              $processes.html('<div style="padding: 8px; color: var(--error-red); font-size: 11px;">' + (response ? response.error : 'Failed to load processes') + '</div>');
              return;
            }

            const processes = response.processes || [];
            if (processes.length === 0) {
              $processes.html('<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">No recent processes</div>');
              return;
            }

            $processes.empty();
            processes.forEach(function(proc) {
              const $item = $('<div class="process-item">');
              const statusClass = proc.status === 'COMPLETED' ? 'completed' : 'failed';
              const $status = $('<span class="process-status ' + statusClass + '">');
              const time = new Date(proc.startTime).toLocaleTimeString();
              const duration = proc.duration ? ' (' + proc.duration + 'ms)' : '';
              const $text = $('<span>').text(proc.functionName + ' - ' + time + duration);
              $item.append($status, $text);
              $processes.append($item);
            });
          })
          .catch(function(error) {
            window.DataLoader._loadingProcesses = false;
            $processes.html('<div style="padding: 8px; color: var(--error-red); font-size: 11px;">Error: ' + error.message + '</div>');
          });
      },

      loadLogs: function(minutes) {
        if (this._loadingLogs) {
          console.log('[DataLoader] Logs request already in progress, skipping');
          return;
        }
        
        const $content = $('#logsContent');
        const $status = $('#logsStatus');

        $content.html('<div class="log-empty">Loading logs...</div>');
        $status.text('Loading...');

        if (!window.server) {
          $content.html('<div class="log-empty">server not available</div>');
          $status.text('');
          return;
        }

        this._loadingLogs = true;

        window.server.exec_api(null, 'common-js/__mcp_exec', 'getScriptLogs', minutes)
          .then(function(response) {
            window.DataLoader._loadingLogs = false;
            if (!response || !response.success) {
              $content.html('<div class="log-empty">' + (response ? response.error : 'Failed to load logs') + '</div>');
              $status.text('Error');
              return;
            }

            const logs = response.logs || [];
            const timeRange = minutes === 0 ? 'all' : minutes + ' min';
            $status.text(logs.length + ' entries (' + timeRange + ')');

            if (logs.length === 0) {
              $content.html('<div class="log-empty">No logs found for the selected time range</div>');
              return;
            }

            $content.empty();
            logs.forEach(function(log) {
              const $entry = $('<div class="log-entry ' + (log.severity || 'info').toLowerCase() + '">');

              if (log.timestamp) {
                const $timestamp = $('<div class="log-timestamp">').text(new Date(log.timestamp).toLocaleString());
                $entry.append($timestamp);
              }

              if (log.functionName) {
                const $function = $('<div class="log-function">').text('Function: ' + log.functionName);
                $entry.append($function);
              }

              const $message = $('<div class="log-message">').text(log.message || log.textPayload || JSON.stringify(log));
              $entry.append($message);

              $content.append($entry);
            });
          })
          .catch(function(error) {
            window.DataLoader._loadingLogs = false;
            $content.html('<div class="log-empty">Error: ' + error.message + '</div>');
            $status.text('Error');
          });
      }
    };

    window.CodeExecutor = {
      commandHistory: [],
      historyIndex: -1,

      execute: async function() {
        const $input = $('#codeInput');
        const code = $input.val().trim();

        if (!code) return;

        // Add to history
        window.CodeExecutor.commandHistory.push(code);
        window.CodeExecutor.historyIndex = window.CodeExecutor.commandHistory.length;

        const startTime = performance.now();

        try {
          let codeToExecute = code;
          let hasRunCall = code.includes('run(');

          // For run() calls in assignments, we need special handling
          // to ensure the variable gets the resolved value, not the Promise
          if (hasRunCall && /^\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*run\(/.test(code)) {
            // Assignment like: z = run("code")
            // Extract variable name and run call
            const match = code.match(/^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(.+)$/);
            if (match) {
              const varName = match[1];
              const runCall = match[2];
              // Echo the command BEFORE executing (REPL style)
              const $console = $('#console');
              const $commandEcho = $('<div style="color: var(--text-secondary); font-family: Consolas, Monaco, monospace; font-size: 13px; margin-bottom: 8px; padding: 4px 8px; background: var(--bg-secondary); border-radius: 3px; display: flex; align-items: center; gap: 8px;">');
              const $commandText = $('<span>').text('> ' + code);
              const $replayBtn = $('<button class="replay-btn" style="margin-left: auto;" title="Re-run this command">↻</button>');
              $replayBtn.on('click', function() {
                $('#codeInput').val(code);
                window.CodeExecutor.execute();
              });
              $commandEcho.append($commandText, $replayBtn);
              $console.append($commandEcho);

              // Execute run(), await it, then assign to variable
              codeToExecute = `const __temp = await (${runCall}); clientState.set('${varName}', __temp.__runHandled ? __temp.value : __temp); return __temp;`;
            } else {
              codeToExecute = code;
            }
          } else {
            // Normal expression evaluation
            try {
              new Function('return ' + code);
              codeToExecute = 'return ' + code;
            } catch (e) {
              codeToExecute = code;
            }
          }

          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('clientState', 'run', codeToExecute);
          const boundRun = function(serverCode) {
            return clientState.run(serverCode, code);
          };
          const result = await fn(clientState, boundRun);

          const clientTime = (performance.now() - startTime).toFixed(2);

          if (result && typeof result.then === 'function') {
            return;
          }

          // Check if run() already handled output
          if (result && result.__runHandled) {
            // For run() assignments, we already handled clientState.set() above
            // For direct run() calls, we still need to inspect
            if (!hasRunCall || !/^\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*run\(/.test(code)) {
              clientState.inspectAndUpdate(code, result.value);
            }
            return;  // Skip duplicate output
          }

          clientState.inspectAndUpdate(code, result);

          if (result !== undefined) {
            const displayResult = typeof result === 'object'
              ? JSON.stringify(result, null, 2)
              : String(result);
            window.UI.addOutput(displayResult, 'success', null, 'client: ' + clientTime + 'ms', code);
          } else {
            window.UI.addOutput('(undefined)', 'success', null, 'client: ' + clientTime + 'ms', code);
          }
        } catch (error) {
          const clientTime = (performance.now() - startTime).toFixed(2);
          window.UI.addOutput(error.message, 'error', null, 'client: ' + clientTime + 'ms', code);
        }

        $input.val('');
      }
    };

    window.DeploymentManager = {
      currentEnv: 'unknown',
      urls: { dev: null, staging: null, prod: null },

      init: function() {
        this.loadDeploymentInfo();
        this.setupEventHandlers();
      },

      loadDeploymentInfo: function() {
        if (!window.server) {
          console.error('server not available');
          return;
        }

        const self = this;
        let urlsLoaded = false;
        let envLoaded = false;
        
        function tryUpdateUI() {
          if (urlsLoaded && envLoaded) {
            self.updateUI();
          }
        }

        // Load URLs
        window.server.exec_api(null, 'common-js/__mcp_exec', 'getDeploymentUrls')
          .then(function(urls) {
            self.urls = urls;
            urlsLoaded = true;
            tryUpdateUI();
          })
          .catch(function(error) {
            console.error('Failed to load deployment URLs:', error);
            urlsLoaded = true;
            tryUpdateUI();
          });

        // Load current environment
        window.server.exec_api(null, 'common-js/__mcp_exec', 'getCurrentDeploymentType')
          .then(function(envType) {
            self.currentEnv = envType;
            envLoaded = true;
            tryUpdateUI();
          })
          .catch(function(error) {
            console.error('Failed to load current environment:', error);
            envLoaded = true;
            tryUpdateUI();
          });
      },

      updateUI: function() {
        const { currentEnv, urls } = this;

        // Update header badge
        const $badge = $('#envBadge');
        $badge.removeClass('dev staging prod').addClass(currentEnv);
        $badge.find('.env-badge-text').text(currentEnv.toUpperCase());

        // Update dropdown and tab
        ['dev', 'staging', 'prod'].forEach(env => {
          const url = urls[env] || 'Not deployed';
          const isCurrent = env === currentEnv;

          // Update dropdown
          const $dropdownItem = $(`.env-dropdown-item[data-env="${env}"]`);
          $dropdownItem.find('.env-link').attr('href', url).text(url);
          $dropdownItem.find('.env-current-marker').toggle(isCurrent);

          // Update tab
          const $card = $(`.deployment-card[data-env="${env}"]`);
          $card.find('.deployment-url').attr('href', url).text(url);
          $card.find('.deployment-current').toggle(isCurrent);
        });
      },

      setupEventHandlers: function() {
        // Toggle dropdown
        $('#envBadge').on('click', function(e) {
          e.stopPropagation();
          $('#envDropdown').toggleClass('hidden');
        });

        // Close dropdown when clicking outside
        $(document).on('click', function() {
          $('#envDropdown').addClass('hidden');
        });

        $('#envDropdown').on('click', function(e) {
          e.stopPropagation();
        });

        // Copy URL buttons
        $('.env-copy-btn, .copy-url-btn').on('click', function() {
          const url = $(this).siblings('.env-link, .deployment-url').attr('href');
          navigator.clipboard.writeText(url).then(() => {
            const $btn = $(this);
            const originalText = $btn.text();
            $btn.text('✓');
            setTimeout(() => $btn.text(originalText), 1500);
          });
        });

        // Promote buttons (dropdown)
        $('.env-promote-btn').on('click', function() {
          const toEnv = $(this).data('to');
          window.DeploymentManager.promoteDeployment(toEnv);
        });

        // Promote buttons (tab)
        $('.promote-action-btn').on('click', function() {
          const toEnv = $(this).data('to');
          window.DeploymentManager.promoteDeployment(toEnv);
        });

        // Full management button
        $('.env-full-mgmt-btn').on('click', function() {
          $('.tab').removeClass('active');
          $('.tab[data-tab="deployments"]').addClass('active');
          $('.tab-content').removeClass('active');
          $('#deployments').addClass('active');
          $('#envDropdown').addClass('hidden');
        });

        // Refresh button
        $('#refreshDeploymentsTab').on('click', function() {
          window.DeploymentManager.loadDeploymentInfo();
        });
      },

      promoteDeployment: function(toEnv) {
        let description = '';

        if (toEnv === 'staging') {
          description = prompt('Enter version description for staging promotion:');
          
          // Validate description (handle null for cancel, empty string, whitespace-only)
          if (description === null) {
            // User clicked Cancel
            return;
          }
          
          description = description.trim();
          
          if (description === '') {
            window.UI.addOutput('❌ Version description cannot be empty', 'error');
            return;
          }
          
          if (description.length < 3) {
            window.UI.addOutput('❌ Version description must be at least 3 characters', 'error');
            return;
          }
        } else {
          if (!confirm(`Promote staging to production?\n\nThis will update the production deployment.`)) {
            return;
          }
        }

        // Show loading state
        window.UI.addOutput('Promoting to ' + toEnv + '...', 'info');

        window.server.exec_api(null, 'common-js/__mcp_exec', 'promoteDeployment', toEnv, description)
          .then(function(result) {
            if (result.success) {
              window.UI.addOutput(
                '✅ ' + result.message + (result.version ? ' (v' + result.version + ')' : ''),
                'success'
              );
              window.DeploymentManager.loadDeploymentInfo(); // Refresh
            } else {
              window.UI.addOutput('❌ Promotion failed: ' + result.error, 'error');
            }
          })
          .catch(function(error) {
            window.UI.addOutput('❌ Promotion failed: ' + error.message, 'error');
          });
      }
    };

    $(document).ready(function() {
      // Initialize Promise-based server API wrapper
      const server = createGasServer({ debug: false });
      window.server = server; // Make available globally
      console.log('[Debug Console] Server API wrapper initialized');
      // Load script info
      window.DataLoader.loadScriptInfo();

      // Setup session time counter
      const sessionStart = new Date();
      const sessionTimerInterval = setInterval(function() {
        const elapsed = Math.floor((new Date() - sessionStart) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        if (minutes > 0) {
          $('#sessionTime').text(minutes + 'm ' + seconds + 's');
        } else {
          $('#sessionTime').text(seconds + 's');
        }
      }, 1000);

      // Click-to-copy functionality
      $('.copyable').on('click', function() {
        const $elem = $(this);
        const textToCopy = $elem.find('.info-value').text();

        if (!textToCopy || textToCopy === 'Loading...' || textToCopy === 'Error loading') {
          return;
        }

        // Copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textToCopy).then(function() {
            $elem.addClass('copied');
            setTimeout(function() {
              $elem.removeClass('copied');
            }, 1500);
          }).catch(function(err) {
            console.error('Copy failed:', err);
          });
        } else {
          // Fallback for older browsers
          const textarea = document.createElement('textarea');
          textarea.value = textToCopy;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand('copy');
            $elem.addClass('copied');
            setTimeout(function() {
              $elem.removeClass('copied');
            }, 1500);
          } catch (err) {
            console.error('Copy failed:', err);
          }
          document.body.removeChild(textarea);
        }
      });

      // Logs controls
      $('#logsTimeRange').on('change', function() {
        const minutes = parseInt($(this).val());
        window.DataLoader.loadLogs(minutes);
      });

      $('#refreshLogsBtn').on('click', function() {
        const minutes = parseInt($('#logsTimeRange').val());
        window.DataLoader.loadLogs(minutes);
      });

      // Auto-refresh logs when Logs tab is active
      let logsRefreshInterval = null;
      $('.tab').on('click', function() {
        const tab = $(this).data('tab');
        if (tab === 'logs') {
          const minutes = parseInt($('#logsTimeRange').val());
          window.DataLoader.loadLogs(minutes);
          // Auto-refresh every 10 seconds
          if (logsRefreshInterval) clearInterval(logsRefreshInterval);
          logsRefreshInterval = setInterval(function() {
            if ($('.tab[data-tab="logs"]').hasClass('active')) {
              window.DataLoader.loadLogs(parseInt($('#logsTimeRange').val()));
            }
          }, 10000);
        } else {
          if (logsRefreshInterval) {
            clearInterval(logsRefreshInterval);
            logsRefreshInterval = null;
          }
        }
      });

      // Auto-refresh processes every 30 seconds
      const processesRefreshInterval = setInterval(function() {
        if ($('#processesPanel').is(':visible') && !$('#processesPanel').hasClass('collapsed')) {
          window.DataLoader.loadProcesses();
        }
      }, 30000);

      // Cleanup timers on page unload (resource leak prevention)
      $(window).on('beforeunload', function() {
        if (sessionTimerInterval) clearInterval(sessionTimerInterval);
        if (logsRefreshInterval) clearInterval(logsRefreshInterval);
        if (processesRefreshInterval) clearInterval(processesRefreshInterval);
      });

      $('#executeBtn').on('click', window.CodeExecutor.execute);

      $('#codeInput').on('keypress', function(e) {
        if (e.which === 13) {
          window.CodeExecutor.execute();
        }
      });

      // Command history navigation with arrow keys
      $('#codeInput').on('keydown', function(e) {
        const $input = $(this);
        const history = window.CodeExecutor.commandHistory;

        if (e.which === 38) {  // Arrow Up
          e.preventDefault();
          if (window.CodeExecutor.historyIndex > 0) {
            window.CodeExecutor.historyIndex--;
            $input.val(history[window.CodeExecutor.historyIndex]);
          }
        } else if (e.which === 40) {  // Arrow Down
          e.preventDefault();
          if (window.CodeExecutor.historyIndex < history.length - 1) {
            window.CodeExecutor.historyIndex++;
            $input.val(history[window.CodeExecutor.historyIndex]);
          } else if (window.CodeExecutor.historyIndex === history.length - 1) {
            window.CodeExecutor.historyIndex = history.length;
            $input.val('');
          }
        }
      });

      // Filter functionality with debouncing
      $('#stateFilter').on('input', function() {
        const value = $(this).val();
        
        // Clear previous timeout
        if (window.StateRenderer._filterTimeout) {
          clearTimeout(window.StateRenderer._filterTimeout);
        }
        
        // Debounce filter rendering (300ms delay)
        window.StateRenderer._filterTimeout = setTimeout(function() {
          window.StateRenderer.filterText = value;
          window.StateRenderer.render(clientState.storage);
        }, 300);
      });

      $('#filterToggle').on('click', function() {
        const $btn = $(this);
        if (window.StateRenderer.filterMode === 'names') {
          window.StateRenderer.filterMode = 'values';
          $btn.text('Values').addClass('active');
        } else {
          window.StateRenderer.filterMode = 'names';
          $btn.text('Names').removeClass('active');
        }
        window.StateRenderer.render(clientState.storage);
      });

      $('#filterClear').on('click', function() {
        $('#stateFilter').val('');
        window.StateRenderer.filterText = '';
        window.StateRenderer.render(clientState.storage);
      });

      $('.tab').on('click', function() {
        const tab = $(this).data('tab');
        $('.tab').removeClass('active');
        $('.tab-content').removeClass('active');
        $(this).addClass('active');
        $('#' + tab).addClass('active');
      });

      $('.panel h3').on('click', function() {
        const $panel = $(this).closest('.panel');
        const $icon = $(this).find('.expand-icon');
        const $content = $panel.find('.panel-content');

        $icon.toggleClass('collapsed');
        $content.toggleClass('collapsed');
      });

      $('#clearStateBtn').on('click', function(e) {
        e.stopPropagation();
        if (confirm('Clear all client state variables?')) {
          clientState.clear();
        }
      });

      $('#refreshProcessesBtn').on('click', function(e) {
        e.stopPropagation();
        window.DataLoader.loadProcesses();
      });

      $('#scrollHint').on('click', function() {
        const $console = $('#console');
        $console.scrollTop($console[0].scrollHeight);
        $('#scrollHint').removeClass('visible');
      });

      window.DataLoader.loadProcesses();
      window.DeploymentManager.init();
      
      // Console Management Event Handlers
      $('#clearConsoleBtn').on('click', function() {
        window.ConsoleManager.clear();
      });

      $('#consoleSearch').on('input', function() {
        const text = $(this).val();
        clearTimeout(window.ConsoleManager._searchTimeout);
        window.ConsoleManager._searchTimeout = setTimeout(function() {
          window.ConsoleManager.search(text);
        }, 300);
      });

      $('#searchPrev').on('click', function() {
        window.ConsoleManager.navigateMatch(-1);
      });

      $('#searchNext').on('click', function() {
        window.ConsoleManager.navigateMatch(1);
      });

      $('#searchClear').on('click', function() {
        $('#consoleSearch').val('');
        window.ConsoleManager.search('');
      });

      // Filter dropdown toggle
      $('#filterToggle').on('click', function(e) {
        e.stopPropagation();
        $('#filterMenu').toggleClass('hidden');
        $('#exportMenu').addClass('hidden');
      });

      $('#filterMenu input').on('change', function() {
        const type = $(this).data('type');
        window.ConsoleManager.activeFilters[type] = $(this).prop('checked');
        window.ConsoleManager.applyFilters();
      });

      // Export dropdown toggle
      $('#exportToggle').on('click', function(e) {
        e.stopPropagation();
        $('#exportMenu').toggleClass('hidden');
        $('#filterMenu').addClass('hidden');
      });

      $('#exportMenu button').on('click', function() {
        const format = $(this).data('format');
        window.ConsoleManager.export(format);
        $('#exportMenu').addClass('hidden');
      });

      // Close dropdowns when clicking outside
      $(document).on('click', function() {
        $('#filterMenu').addClass('hidden');
        $('#exportMenu').addClass('hidden');
      });

      // Prevent dropdown close when clicking inside
      $('#filterMenu, #exportMenu').on('click', function(e) {
        e.stopPropagation();
      });

      // Keyboard shortcuts
      $(document).on('keydown', function(e) {
        // Ctrl/Cmd + K = Clear console
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
          e.preventDefault();
          window.ConsoleManager.clear();
        }
      });
      
      // Show security warning banner on first use (or if localStorage unavailable)
      const hasSeenWarning = localStorage && localStorage.getItem('gas-repl-warning-seen');
      if (!hasSeenWarning) {
        const warningHtml = '<div style="background: var(--warning-yellow); color: #000; padding: 12px; border-radius: 4px; margin-bottom: 8px; border-left: 4px solid #f39c12;">' +
          '<div style="font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">' +
          '<span style="font-size: 16px;">⚠️</span>' +
          '<span>Security Notice: REPL Console</span>' +
          '</div>' +
          '<div style="font-size: 11px; line-height: 1.5;">' +
          'This console executes arbitrary JavaScript code with full access to your Google Apps Script project. ' +
          'Only run code you understand and trust. Variables are stored in browser memory and cleared on page reload.' +
          '</div>' +
          '</div>';
        
        const $console = $('#console');
        $console.append(warningHtml);
        
        // Mark as seen (won't show again)
        if (localStorage) {
          try {
            localStorage.setItem('gas-repl-warning-seen', 'true');
          } catch (e) {
            // localStorage might be disabled - silent fail
          }
        }
      }
      
      window.UI.addOutput('Debugger initialized', 'info');
    });
  </script>