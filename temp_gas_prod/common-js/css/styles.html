<style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --bg-primary: #1e1e1e;
      --bg-secondary: #252526;
      --bg-tertiary: #2d2d30;
      --text-primary: #cccccc;
      --text-secondary: #858585;
      --border-color: #3e3e42;
      --accent-blue: #0e639c;
      --success-green: #4ec9b0;
      --error-red: #f48771;
      --warning-yellow: #ce9178;
      --type-number: #b5cea8;
      --type-string: #ce9178;
      --type-boolean: #569cd6;
      --type-null: #808080;
      --type-undefined: #808080;
      --type-function: #dcdcaa;
      --type-object: #4ec9b0;
      --type-array: #4fc1ff;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .header h1 {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      flex-shrink: 0;
    }

    .header-info {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      overflow: hidden;
    }

    .info-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .info-label {
      font-weight: 500;
      color: var(--text-secondary);
    }

    .info-value {
      color: var(--text-primary);
      font-family: 'Consolas', 'Monaco', monospace;
    }

    .copyable {
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }

    .copyable:hover {
      background: var(--bg-primary);
      color: var(--accent-blue);
    }

    .copyable:hover::after {
      content: 'Click to copy';
      position: absolute;
      top: -24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      white-space: nowrap;
      border: 1px solid var(--border-color);
      z-index: 1000;
      pointer-events: none;
    }

    .copyable.copied {
      background: var(--success-green);
      color: white;
    }

    .copyable.copied::after {
      content: 'Copied!' !important;
      background: var(--success-green);
    }

    .main-container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .sidebar {
      width: 320px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .panel {
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .panel:last-child {
      flex: 1;
      overflow-y: auto;
    }

    .panel h3 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
      padding: 12px 16px;
      margin: 0;
      background: var(--bg-tertiary);
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .panel-content {
      padding: 8px;
    }

    .panel-content.collapsed {
      display: none;
    }

    .expand-icon {
      font-size: 10px;
      display: inline-block;
      transition: transform 0.2s;
    }

    .expand-icon.collapsed {
      transform: rotate(-90deg);
    }

    .panel-btn {
      background: var(--accent-blue);
      border: none;
      color: white;
      cursor: pointer;
      border-radius: 3px;
      font-size: 10px;
      padding: 2px 8px;
    }

    .panel-btn:hover {
      opacity: 0.9;
    }

    .filter-container {
      padding: 8px;
      display: flex;
      gap: 4px;
      align-items: center;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
    }

    .filter-input {
      flex: 1;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: 'Consolas', 'Monaco', monospace;
    }

    .filter-input:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .filter-toggle {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .filter-toggle.active {
      background: var(--accent-blue);
      color: white;
      border-color: var(--accent-blue);
    }

    .filter-clear {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 14px;
      padding: 4px;
      display: flex;
      align-items: center;
      transition: color 0.2s;
    }

    .filter-clear:hover {
      color: var(--text-primary);
    }

    .state-tree-item {
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      margin: 2px 0;
    }

    .state-tree-header {
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }

    .state-tree-header:hover {
      background: #3a3a3c;
    }

    .tree-expand-icon {
      font-size: 10px;
      color: var(--text-secondary);
      transition: transform 0.2s;
      flex-shrink: 0;
    }

    .tree-expand-icon.expanded {
      transform: rotate(90deg);
    }

    .tree-expand-icon.leaf {
      opacity: 0;
    }

    .state-emoji {
      font-size: 11px;
      opacity: 0.5;
      margin-left: auto;
      padding-left: 8px;
      flex-shrink: 0;
    }

    .state-key {
      color: var(--success-green);
      font-weight: 500;
      flex-shrink: 0;
      order: -1;
    }

    .state-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-left: 8px;
    }

    .state-value.number {
      color: var(--type-number);
    }

    .state-value.string {
      color: var(--type-string);
    }

    .state-value.boolean {
      color: var(--type-boolean);
    }

    .state-value.null {
      color: var(--type-null);
    }

    .state-value.undefined {
      color: var(--type-undefined);
    }

    .state-value.function {
      color: var(--type-function);
    }

    .state-value.object {
      color: var(--type-object);
    }

    .state-value.array {
      color: var(--type-array);
    }

    .state-tree-children {
      margin-left: 20px;
      margin-top: 2px;
      display: none;
    }

    .state-tree-children.expanded {
      display: block;
    }

    .state-path {
      color: var(--text-secondary);
      font-size: 10px;
      margin-left: 4px;
    }

    .console-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .tab-bar {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      display: flex;
      gap: 0;
      padding: 0 16px;
    }

    .tab {
      padding: 8px 16px;
      font-size: 13px;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }

    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent-blue);
    }

    .tab:hover:not(.active) {
      color: var(--text-primary);
    }

    /* Console Toolbar */
    .console-toolbar {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .toolbar-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }

    .toolbar-btn:hover {
      background: var(--bg-primary);
      border-color: var(--accent-blue);
    }

    .toolbar-btn:active {
      background: var(--accent-blue);
      color: white;
    }

    /* Search Box */
    .search-box {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 4px 8px;
      flex: 1;
      min-width: 200px;
      max-width: 400px;
    }

    .search-input {
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 12px;
      font-family: 'Consolas', 'Monaco', monospace;
      outline: none;
      flex: 1;
      min-width: 0;
    }

    .search-input::placeholder {
      color: var(--text-secondary);
      opacity: 0.6;
    }

    .search-counter {
      color: var(--text-secondary);
      font-size: 11px;
      padding: 0 4px;
      white-space: nowrap;
    }

    .search-nav-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 12px;
      transition: all 0.2s;
    }

    .search-nav-btn:hover {
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .search-nav-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .search-clear-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 14px;
      transition: all 0.2s;
    }

    .search-clear-btn:hover {
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    /* Search Match Highlighting */
    .search-match {
      background: rgba(255, 255, 100, 0.2);
      border-radius: 2px;
      padding: 0 2px;
    }

    .search-match.active {
      background: rgba(255, 255, 0, 0.4);
      border: 1px solid var(--warning-yellow);
      padding: 0 1px;
      animation: pulse 0.3s ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    /* Filter Dropdown */
    .filter-dropdown {
      position: relative;
    }

    .filter-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      min-width: 180px;
      z-index: 1000;
      padding: 8px;
    }

    .filter-menu.hidden {
      display: none;
    }

    .filter-menu label {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
      color: var(--text-primary);
      transition: background 0.2s;
    }

    .filter-menu label:hover {
      background: var(--bg-tertiary);
    }

    .filter-menu input[type="checkbox"] {
      cursor: pointer;
      width: 14px;
      height: 14px;
    }

    .filter-counter {
      color: var(--text-secondary);
      font-size: 10px;
      padding: 8px 8px 4px 8px;
      border-top: 1px solid var(--border-color);
      margin-top: 4px;
      text-align: center;
    }

    /* Export Dropdown */
    .export-dropdown {
      position: relative;
    }

    .export-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      min-width: 160px;
      z-index: 1000;
      overflow: hidden;
    }

    .export-menu.hidden {
      display: none;
    }

    .export-menu button {
      background: transparent;
      border: none;
      color: var(--text-primary);
      padding: 10px 12px;
      width: 100%;
      text-align: left;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.2s;
      border-bottom: 1px solid var(--border-color);
    }

    .export-menu button:last-child {
      border-bottom: none;
    }

    .export-menu button:hover {
      background: var(--bg-tertiary);
    }

    /* Toast Notifications */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      padding: 12px 20px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      font-size: 13px;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.3s ease-out;
      z-index: 10000;
      pointer-events: none;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .tab-content {
      display: none;
      flex: 1;
      overflow-y: auto;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      padding: 16px;
      line-height: 1.6;
    }

    .tab-content.active {
      display: block;
    }

    .output-container {
      margin-bottom: 16px;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      border-left: 3px solid transparent;
    }

    .output-container.success {
      border-left-color: var(--success-green);
    }

    .output-container.error {
      border-left-color: var(--error-red);
    }

    .output-container.info {
      border-left-color: var(--accent-blue);
    }

    .output-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .replay-btn {
      margin-left: auto;
      background: transparent;
      border: none;
      color: var(--accent-blue);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 14px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .replay-btn:hover {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    .timestamp {
      color: var(--text-secondary);
      font-size: 11px;
      flex-shrink: 0;
    }

    .output-message {
      margin-bottom: 6px;
      line-height: 1.5;
    }

    .output-message.success {
      color: var(--success-green);
    }

    .output-message.error {
      color: var(--error-red);
    }

    .output-message.info {
      color: var(--accent-blue);
    }

    .timing-info {
      color: var(--text-secondary);
      font-size: 11px;
      font-style: italic;
    }

    .log-toggle {
      color: var(--accent-blue);
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      padding: 4px 8px;
      background: var(--bg-secondary);
      border-radius: 4px;
      transition: background 0.2s;
    }

    .log-toggle:hover {
      background: var(--bg-primary);
    }

    .log-arrow {
      font-size: 10px;
      transition: transform 0.2s;
      display: inline-block;
    }

    .log-arrow.expanded {
      transform: rotate(90deg);
    }

    .server-logs {
      margin-top: 8px;
      padding: 10px;
      background: var(--bg-primary);
      border-radius: 4px;
      color: var(--text-secondary);
      font-size: 11px;
      white-space: pre-wrap;
      border: 1px solid var(--border-color);
    }

    .server-logs.hidden {
      display: none;
    }

    .input-area {
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
      padding: 12px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .input-field {
      flex: 1;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 8px 12px;
      border-radius: 4px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
    }

    .input-field:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .execute-btn {
      background: var(--accent-blue);
      border: none;
      color: white;
      padding: 8px 20px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .execute-btn:hover {
      opacity: 0.9;
    }

    .process-item {
      background: var(--bg-tertiary);
      padding: 8px 12px;
      margin-bottom: 6px;
      border-radius: 4px;
      font-size: 12px;
    }

    .process-status {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }

    .process-status.completed {
      background: var(--success-green);
    }

    .process-status.failed {
      background: var(--error-red);
    }

    .scroll-hint {
      position: fixed;
      bottom: 80px;
      right: 40px;
      background: var(--accent-blue);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      z-index: 1000;
    }

    .scroll-hint.visible {
      opacity: 0.9;
      pointer-events: auto;
    }

    .highlight-match {
      background: rgba(255, 255, 0, 0.3);
      padding: 0 2px;
      border-radius: 2px;
    }

    .logs-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .logs-select {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
    }

    .logs-select:hover {
      border-color: var(--accent-blue);
    }

    .logs-select:focus {
      border-color: var(--accent-blue);
    }

    .logs-status {
      color: var(--text-secondary);
      font-size: 11px;
      margin-left: auto;
    }

    #logsContent {
      padding: 16px;
      overflow-y: auto;
      max-height: calc(100% - 60px);
    }

    .log-entry {
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      margin-bottom: 12px;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      border-left: 3px solid var(--border-color);
      line-height: 1.5;
    }

    .log-entry.info {
      border-left-color: var(--accent-blue);
    }

    .log-entry.warning {
      border-left-color: var(--warning-yellow);
    }

    .log-entry.error {
      border-left-color: var(--error-red);
    }

    .log-entry.success {
      border-left-color: var(--success-green);
    }

    .log-timestamp {
      color: var(--text-secondary);
      font-size: 10px;
      margin-bottom: 4px;
    }

    .log-function {
      color: var(--success-green);
      font-weight: 500;
      margin-bottom: 4px;
    }

    .log-message {
      color: var(--text-primary);
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .log-empty {
      color: var(--text-secondary);
      text-align: center;
      padding: 40px 20px;
      font-size: 13px;
    }

    /* Environment Badge in Header */
    .env-badge-container {
      position: relative;
      margin-left: 8px;
    }

    .env-badge {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .env-badge:hover {
      background: var(--bg-primary);
      border-color: var(--accent-blue);
    }

    .env-badge-icon {
      font-size: 8px;
    }

    .env-badge.dev { border-left: 3px solid var(--warning-yellow); }
    .env-badge.dev .env-badge-icon { color: var(--warning-yellow); }

    .env-badge.staging { border-left: 3px solid var(--accent-blue); }
    .env-badge.staging .env-badge-icon { color: var(--accent-blue); }

    .env-badge.prod { border-left: 3px solid var(--success-green); }
    .env-badge.prod .env-badge-icon { color: var(--success-green); }

    .env-badge-arrow {
      font-size: 8px;
      opacity: 0.5;
    }

    /* Environment Dropdown */
    .env-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      min-width: 320px;
      z-index: 1000;
      overflow: hidden;
    }

    .env-dropdown.hidden {
      display: none;
    }

    .env-dropdown-header {
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-secondary);
    }

    .env-dropdown-item {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-color);
    }

    .env-dropdown-item:last-of-type {
      border-bottom: none;
    }

    .env-dropdown-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .env-dot {
      font-size: 8px;
    }

    .dev-dot { color: var(--warning-yellow); }
    .staging-dot { color: var(--accent-blue); }
    .prod-dot { color: var(--success-green); }

    .env-current-marker {
      color: var(--success-green);
      font-size: 10px;
      margin-left: auto;
    }

    .env-dropdown-url {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }

    .env-link {
      flex: 1;
      font-size: 10px;
      color: var(--accent-blue);
      text-decoration: none;
      font-family: 'Consolas', monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .env-link:hover {
      text-decoration: underline;
    }

    .env-copy-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      cursor: pointer;
    }

    .env-copy-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .env-promote-btn {
      background: var(--accent-blue);
      border: none;
      color: white;
      padding: 4px 12px;
      border-radius: 3px;
      font-size: 10px;
      cursor: pointer;
      width: 100%;
      margin-top: 4px;
    }

    .env-promote-btn:hover {
      opacity: 0.9;
    }

    .env-dropdown-footer {
      padding: 8px 12px;
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border-color);
    }

    .env-full-mgmt-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      width: 100%;
    }

    .env-full-mgmt-btn:hover {
      background: var(--bg-primary);
      border-color: var(--accent-blue);
    }

    /* Deployments Tab */
    .deployments-container {
      padding: 16px;
    }

    .deployments-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .deployments-header h2 {
      font-size: 18px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .deployment-card {
      background: var(--bg-tertiary);
      border-radius: 6px;
      margin-bottom: 16px;
      overflow: hidden;
      border-left: 4px solid var(--border-color);
    }

    .deployment-card[data-env="dev"] {
      border-left-color: var(--warning-yellow);
    }

    .deployment-card[data-env="staging"] {
      border-left-color: var(--accent-blue);
    }

    .deployment-card[data-env="prod"] {
      border-left-color: var(--success-green);
    }

    .deployment-card-header {
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .deployment-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 3px;
      color: white;
    }

    .dev-badge { background: var(--warning-yellow); }
    .staging-badge { background: var(--accent-blue); }
    .prod-badge { background: var(--success-green); }

    .deployment-current {
      font-size: 11px;
      color: var(--success-green);
      font-weight: 500;
    }

    .deployment-card-body {
      padding: 16px;
    }

    .deployment-url-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    .deployment-url-row label {
      font-size: 11px;
      color: var(--text-secondary);
      font-weight: 600;
    }

    .deployment-url {
      flex: 1;
      font-size: 12px;
      font-family: 'Consolas', monospace;
      color: var(--accent-blue);
      text-decoration: none;
    }

    .deployment-url:hover {
      text-decoration: underline;
    }

    .copy-url-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 4px 10px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
    }

    .copy-url-btn:hover {
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .deployment-info {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .deployment-card-footer {
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    .promote-action-btn {
      background: var(--accent-blue);
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      width: 100%;
    }

    .promote-action-btn:hover {
      opacity: 0.9;
    }

    .promote-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>