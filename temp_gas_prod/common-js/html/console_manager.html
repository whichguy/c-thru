<script>
/**
 * Console Management Module
 * Provides clear, search, filter, and export functionality for console output
 */
window.ConsoleManager = {
  searchText: '',
  activeFilters: { error: true, warn: true, info: true, success: true },
  currentMatchIndex: -1,
  matchElements: [],
  _searchTimeout: null,

  /**
   * Clear all console output while preserving command history
   */
  clear: function() {
    const $console = $('#console');
    $console.empty();
    
    this.searchText = '';
    this.matchElements = [];
    this.currentMatchIndex = -1;
    
    $('#consoleSearch').val('');
    this.updateSearchUI(0);
    this.showToast('Console cleared');
  },

  /**
   * Search console output and highlight matches
   * @param {string} text - Search term
   */
  search: function(text) {
    this.searchText = text.toLowerCase();
    this.clearHighlights();
    
    if (!text) {
      this.updateSearchUI(0);
      return;
    }

    this.matchElements = [];
    const self = this;
    
    $('.output-message').each(function() {
      const $msg = $(this);
      const content = $msg.text().toLowerCase();
      
      if (content.includes(self.searchText)) {
        $msg.addClass('search-match');
        self.matchElements.push($msg[0]);
      }
    });

    this.updateSearchUI(this.matchElements.length);
    
    if (this.matchElements.length > 0) {
      this.highlightMatch(0);
    }
  },

  /**
   * Navigate to next or previous search match
   * @param {number} direction - 1 for next, -1 for previous
   */
  navigateMatch: function(direction) {
    if (this.matchElements.length === 0) return;

    this.currentMatchIndex += direction;
    
    if (this.currentMatchIndex < 0) {
      this.currentMatchIndex = this.matchElements.length - 1;
    } else if (this.currentMatchIndex >= this.matchElements.length) {
      this.currentMatchIndex = 0;
    }

    this.highlightMatch(this.currentMatchIndex);
  },

  /**
   * Highlight specific search match and scroll to it
   * @param {number} index - Match index to highlight
   */
  highlightMatch: function(index) {
    // Remove active class from all matches
    $('.search-match').removeClass('active');
    
    if (index >= 0 && index < this.matchElements.length) {
      const $match = $(this.matchElements[index]);
      $match.addClass('active');
      
      // Scroll to match
      const $console = $('#console');
      const matchTop = $match.offset().top;
      const consoleTop = $console.offset().top;
      const scrollTop = $console.scrollTop();
      
      $console.scrollTop(scrollTop + matchTop - consoleTop - 100);
      
      this.currentMatchIndex = index;
      this.updateSearchUI(this.matchElements.length);
    }
  },

  /**
   * Clear all search highlights
   */
  clearHighlights: function() {
    $('.search-match').removeClass('search-match active');
    this.matchElements = [];
    this.currentMatchIndex = -1;
  },

  /**
   * Update search UI with match count and current position
   * @param {number} totalMatches - Total number of matches found
   */
  updateSearchUI: function(totalMatches) {
    const $counter = $('#searchCounter');
    
    if (totalMatches === 0) {
      $counter.text('');
    } else {
      const current = this.currentMatchIndex + 1;
      $counter.text(`${current} of ${totalMatches}`);
    }
  },

  /**
   * Apply filters to show/hide console output by type
   */
  applyFilters: function() {
    const self = this;
    let visibleCount = 0;
    const totalCount = $('.output-container').length;
    
    $('.output-container').each(function() {
      const $container = $(this);
      const type = $container.hasClass('error') ? 'error' :
                   $container.hasClass('warn') ? 'warn' :
                   $container.hasClass('info') ? 'info' : 'success';
      
      if (self.activeFilters[type]) {
        $container.show();
        visibleCount++;
      } else {
        $container.hide();
      }
    });

    this.updateFilterUI(visibleCount, totalCount);
    
    // Re-apply search highlighting to visible elements
    if (this.searchText) {
      this.search(this.searchText);
    }
  },

  /**
   * Update filter UI with entry count
   * @param {number} visible - Number of visible entries
   * @param {number} total - Total number of entries
   */
  updateFilterUI: function(visible, total) {
    const $counter = $('#filterCounter');
    
    if (visible === total) {
      $counter.text(`All ${total} entries`);
    } else {
      $counter.text(`Showing ${visible} of ${total}`);
    }
  },

  /**
   * Export console output in specified format
   * @param {string} format - Export format: 'txt', 'json', or 'csv'
   */
  export: function(format) {
    const entries = this.collectVisibleEntries();
    
    if (entries.length === 0) {
      this.showToast('No entries to export');
      return;
    }
    
    switch(format) {
      case 'txt':
        this.exportAsText(entries);
        break;
      case 'json':
        this.exportAsJSON(entries);
        break;
      case 'csv':
        this.exportAsCSV(entries);
        break;
    }
  },

  /**
   * Collect all visible console entries
   * @returns {Array} Array of entry objects
   */
  collectVisibleEntries: function() {
    const entries = [];
    
    $('.output-container:visible').each(function() {
      const $container = $(this);
      const type = $container.hasClass('error') ? 'error' :
                   $container.hasClass('warn') ? 'warn' :
                   $container.hasClass('info') ? 'info' : 'success';
      
      entries.push({
        timestamp: $container.find('.timestamp').text() || '',
        type: type,
        message: $container.find('.output-message').text() || '',
        timing: $container.find('.timing-info').text() || '',
        serverLogs: $container.find('.server-logs').text() || ''
      });
    });
    
    return entries;
  },

  /**
   * Export as plain text file
   * @param {Array} entries - Console entries to export
   */
  exportAsText: function(entries) {
    let content = 'GAS Debugger Console Export\n';
    content += '='.repeat(60) + '\n';
    content += 'Script ID: ' + $('#scriptId').text() + '\n';
    content += 'Script Name: ' + $('#scriptName').text() + '\n';
    content += 'Exported: ' + new Date().toLocaleString() + '\n';
    content += 'Session Duration: ' + $('#sessionTime').text() + '\n';
    content += 'Total Entries: ' + entries.length + '\n';
    content += '='.repeat(60) + '\n\n';

    entries.forEach(function(e, index) {
      content += '[' + e.timestamp + '] [' + e.type.toUpperCase() + ']\n';
      content += e.message + '\n';
      
      if (e.timing) {
        content += 'Timing: ' + e.timing + '\n';
      }
      
      if (e.serverLogs) {
        content += 'Server Logs:\n' + e.serverLogs + '\n';
      }
      
      content += '\n';
    });

    this.downloadFile(content, 'text/plain', 'txt');
  },

  /**
   * Export as JSON file
   * @param {Array} entries - Console entries to export
   */
  exportAsJSON: function(entries) {
    const data = {
      metadata: {
        scriptId: $('#scriptId').text(),
        scriptName: $('#scriptName').text(),
        exportDate: new Date().toISOString(),
        sessionDuration: $('#sessionTime').text(),
        entryCount: entries.length,
        filters: this.activeFilters,
        searchTerm: this.searchText
      },
      entries: entries
    };

    this.downloadFile(JSON.stringify(data, null, 2), 'application/json', 'json');
  },

  /**
   * Export as CSV file
   * @param {Array} entries - Console entries to export
   */
  exportAsCSV: function(entries) {
    let csv = 'Timestamp,Type,Message,Timing,Server Logs\n';
    
    entries.forEach(function(e) {
      // Escape quotes and wrap in quotes
      const escapeCSV = function(str) {
        return '"' + String(str).replace(/"/g, '""') + '"';
      };
      
      csv += escapeCSV(e.timestamp) + ',';
      csv += escapeCSV(e.type) + ',';
      csv += escapeCSV(e.message) + ',';
      csv += escapeCSV(e.timing) + ',';
      csv += escapeCSV(e.serverLogs) + '\n';
    });

    this.downloadFile(csv, 'text/csv', 'csv');
  },

  /**
   * Download file to user's computer
   * @param {string} content - File content
   * @param {string} mimeType - MIME type
   * @param {string} extension - File extension
   */
  downloadFile: function(content, mimeType, extension) {
    const scriptId = $('#scriptId').text().substring(0, 8);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = 'gas-debug-' + scriptId + '-' + timestamp + '.' + extension;

    const blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showToast('Exported: ' + filename);
  },

  /**
   * Show toast notification
   * @param {string} message - Toast message to display
   */
  showToast: function(message) {
    const $toast = $('<div class="toast">').text(message);
    $('body').append($toast);
    
    // Trigger animation
    setTimeout(function() {
      $toast.addClass('show');
    }, 10);
    
    // Remove after 2 seconds
    setTimeout(function() {
      $toast.removeClass('show');
      setTimeout(function() {
        $toast.remove();
      }, 300);
    }, 2000);
  }
};
</script>