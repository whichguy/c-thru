function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const SPREADSHEET_ID = '1AMEPouG0QeSs6fjov-Iha7XrcxO-AyUOckM0aqRGg0A';

  // Tab names (prefixed with _ per project convention)
  const TAB = {
    CAMPAIGNS:   '_Campaigns',
    RECIPIENTS:  '_Recipients',
    SUPPRESSION: '_Suppression',
    CONTENT:     '_CampaignContent',
    DASHBOARD:   '_CampaignDashboard',
    OPT_IN:      '_OptIn',
  };

  // Fixed column headers for each tab
  const HEADERS = {
    [TAB.CAMPAIGNS]: [
      'campaignId','name','type','channel','state','senderEmail','senderName',
      'replyTo','physicalAddress','contentStrategy','sendConfig','scheduledAt',
      'startedAt','completedAt','totalRecipients','sent','failed','bounced',
      'replied','unsubscribed','skipped','lastProcessedRow','dailySentCount',
      'dailyResetDate','warmupDay','estimatedSpamRate','pauseReason','lastBatchAt',
      'estimatedCompleteDate','notes','createdAt','createdBy'
    ],
    [TAB.RECIPIENTS]: [
      'campaignId','email','channelAddress','segment','status','sentAt',
      'messageId','gmailMessageId','threadId','deliveredAt','bouncedAt',
      'bounceType','repliedAt','unsubscribedAt','errorDetails',
      'autoReplyCount'
    ],
    [TAB.SUPPRESSION]: [
      'email','reason','addedAt','source','method'
    ],
    [TAB.CONTENT]: [
      'campaignId','segmentId','subject','htmlBody','textBody','status',
      'generatedAt','model'
    ],
    [TAB.OPT_IN]: [
      'email','consentType','source','consentTimestamp','ipAddress','campaignId'
    ],
  };

  // Column header maps cache: { tabName -> { colName -> 0-based index } }
  const _colMapCache = {};

  /**
   * Returns the active Spreadsheet object.
   */
  function _ss() {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }

  /**
   * Returns sheet by name, or null if not found.
   */
  function _getSheet(name) {
    return _ss().getSheetByName(name);
  }

  /**
   * Gets or creates a header-map for a tab: { colName -> 0-based index }.
   * Reads row 1 from the sheet. Caches per execution.
   */
  function _getColMap(tabName) {
    if (_colMapCache[tabName]) return _colMapCache[tabName];
    const sheet = _getSheet(tabName);
    if (!sheet) throw new Error('Tab not found: ' + tabName);
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) throw new Error('Tab "' + tabName + '" has no columns — call ensureTabs() first');
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const map = {};
    headers.forEach((h, i) => { if (h) map[String(h)] = i; });
    _colMapCache[tabName] = map;
    return map;
  }

  /**
   * Ensures all required tabs exist, creating them if missing.
   * Idempotent — safe to call multiple times.
   * Also injects QUERY formulas into _CampaignDashboard.
   */
  function ensureTabs() {
    const ss = _ss();
    const existing = ss.getSheets().map(s => s.getName());
    log('ensureTabs() | existing sheets: ' + existing.join(', '));

    // Create each tab that doesn't exist
    Object.entries(HEADERS).forEach(([tabName, headers]) => {
      if (!existing.includes(tabName)) {
        const sheet = ss.insertSheet(tabName);
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
        log('Created tab: ' + tabName);
      }
    });

    // Dashboard tab
    if (!existing.includes(TAB.DASHBOARD)) {
      const dash = ss.insertSheet(TAB.DASHBOARD);
      _initDashboard(dash);
      log('Created tab: ' + TAB.DASHBOARD);
    }
  }

  /**
   * Injects QUERY-formula sections into _CampaignDashboard.
   * References columns by position to avoid formula injection from user data.
   */
  function _initDashboard(sheet) {
    sheet.getRange('A1').setValue('=== Active Campaigns ===');
    sheet.getRange('A2').setFormula(
      "=IFERROR(QUERY('_Campaigns'!A:AD, \"SELECT A,B,D,O,P,Q WHERE E='SENDING' OR E='PAUSED' OR E='SCHEDULED'\"), \"No active campaigns\")"
    );
    sheet.getRange('A10').setValue('=== Suppression Summary ===');
    sheet.getRange('A11').setFormula("=COUNTA('_Suppression'!A2:A) & \" total suppressed\"");
    sheet.getRange('A12').setFormula("=COUNTIF('_Suppression'!B2:B,\"unsubscribe\") & \" unsubscribes\"");
    sheet.getRange('A13').setFormula("=COUNTIF('_Suppression'!B2:B,\"hard_bounce\") & \" hard bounces\"");
    sheet.setFrozenRows(0);
    log('Dashboard QUERY formulas injected');
  }

  // ─── _Campaigns tab ────────────────────────────────────────────────────────

  /**
   * Reads a campaign row by campaignId. Returns plain object or null.
   */
  function getCampaign(campaignId) {
    const sheet = _getSheet(TAB.CAMPAIGNS);
    if (!sheet) return null;
    const map = _getColMap(TAB.CAMPAIGNS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][map['campaignId']] === campaignId) {
        return _rowToObj(data[i], map);
      }
    }
    return null;
  }

  /**
   * Appends a new campaign row. Returns the row index (1-based).
   */
  function appendCampaign(fields) {
    const sheet = _getSheet(TAB.CAMPAIGNS);
    if (!sheet) throw new Error('_Campaigns tab not found — call ensureTabs() first');
    const map = _getColMap(TAB.CAMPAIGNS);
    const row = _objToRow(fields, map, HEADERS[TAB.CAMPAIGNS]);
    sheet.appendRow(row);
    return sheet.getLastRow();
  }

  /**
   * Updates specific fields on a campaign row. Thread-safe for state changes.
   * @param {string} campaignId
   * @param {Object} fields - Key/value pairs to update
   * @param {boolean} [useStateLock=false] - Acquire script lock before writing
   */
  function updateCampaign(campaignId, fields, useStateLock) {
    const doUpdate = () => {
      const sheet = _getSheet(TAB.CAMPAIGNS);
      if (!sheet) throw new Error('_Campaigns tab not found');
      const map = _getColMap(TAB.CAMPAIGNS);
      const data = sheet.getDataRange().getValues();

      for (let i = 1; i < data.length; i++) {
        if (data[i][map['campaignId']] === campaignId) {
          // Patch specified fields into the existing row; write once to avoid N API calls
          const rowData = [...data[i]];
          Object.entries(fields).forEach(([key, val]) => {
            if (map[key] !== undefined) {
              rowData[map[key]] = val !== undefined && val !== null ? val : '';
            }
          });
          sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);
          return true;
        }
      }
      return false;
    };

    if (useStateLock) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(5000)) throw new Error('Could not acquire lock for campaign state update');
      try { return doUpdate(); } finally { lock.releaseLock(); }
    }
    return doUpdate();
  }

  /**
   * Returns all campaigns as array of objects. Optional filter by field/value.
   */
  function listCampaigns(filter) {
    const sheet = _getSheet(TAB.CAMPAIGNS);
    if (!sheet) return [];
    const map = _getColMap(TAB.CAMPAIGNS);
    const data = sheet.getDataRange().getValues();
    const results = [];

    for (let i = 1; i < data.length; i++) {
      if (!data[i][map['campaignId']]) continue; // skip empty rows
      const obj = _rowToObj(data[i], map);
      if (filter) {
        const pass = Object.entries(filter).every(([k, v]) => obj[k] === v);
        if (!pass) continue;
      }
      results.push(obj);
    }
    return results;
  }

  // ─── _Recipients tab ───────────────────────────────────────────────────────

  /**
   * Appends recipient rows to _Recipients tab.
   * @param {Array<Object>} recipients - Array of recipient field objects
   */
  function appendRecipients(recipients) {
    const sheet = _getSheet(TAB.RECIPIENTS);
    if (!sheet) throw new Error('_Recipients tab not found');
    const map = _getColMap(TAB.RECIPIENTS);
    const fixedHeaders = HEADERS[TAB.RECIPIENTS];

    // Discover merge-field columns (any column beyond fixed schema)
    const allHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Add any new merge-field column headers not already present
    const existingSet = new Set(allHeaders);
    const newMergeFields = [];
    recipients.forEach(r => {
      Object.keys(r).forEach(k => {
        if (!existingSet.has(k) && !fixedHeaders.includes(k)) {
          newMergeFields.push(k);
          existingSet.add(k);
        }
      });
    });

    if (newMergeFields.length > 0) {
      const lastCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, lastCol, 1, newMergeFields.length).setValues([newMergeFields]);
      delete _colMapCache[TAB.RECIPIENTS]; // invalidate cache
    }

    // Re-read column map after potential header expansion
    const fullMap = _getColMap(TAB.RECIPIENTS);
    const fullHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    const rows = recipients.map(r => _objToRow(r, fullMap, fullHeaders));
    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, fullHeaders.length).setValues(rows);
    }
  }

  /**
   * Returns a batch of PENDING recipients starting at startRow (1-based data row, after header).
   * @returns {Array<{rowIndex: number, data: Object}>}
   */
  function getRecipientBatch(campaignId, startRow, batchSize) {
    const sheet = _getSheet(TAB.RECIPIENTS);
    if (!sheet) return [];
    const map = _getColMap(TAB.RECIPIENTS);
    const data = sheet.getDataRange().getValues();
    const results = [];

    // startRow is 1-based data row index (row 2 = first data row = index 1)
    const dataStart = Math.max(1, startRow);

    for (let i = dataStart; i < data.length && results.length < batchSize; i++) {
      const row = data[i];
      if (row[map['campaignId']] !== campaignId) continue;
      if (row[map['status']] !== 'PENDING') continue;
      results.push({ rowIndex: i, data: _rowToObj(row, map) });
    }
    return results;
  }

  /**
   * Bulk-updates status for multiple recipients. Batches all writes for each row
   * into a single getRange().setValues() call (one API call per updated row, not
   * one per field) to reduce Sheets quota usage for large batches.
   * @param {Array<{rowIndex: number, fields: Object}>} updates
   */
  function bulkUpdateRecipients(updates) {
    if (!updates || updates.length === 0) return;
    const sheet = _getSheet(TAB.RECIPIENTS);
    if (!sheet) return;
    const map = _getColMap(TAB.RECIPIENTS);
    const totalCols = sheet.getLastColumn();

    // Read all existing rows once so we can patch only the changed columns
    const data = sheet.getDataRange().getValues();

    // Sort by sheet row so contiguous runs can be collapsed into multi-row setValues calls,
    // reducing N individual API calls to ceil(N/run_length) calls on average.
    const sorted = updates
      .map(({ rowIndex, fields }) => ({ sheetRow: rowIndex + 1, rowIndex, fields }))
      .sort((a, b) => a.sheetRow - b.sheetRow);

    let i = 0;
    while (i < sorted.length) {
      // Collect a contiguous run starting at sorted[i]
      const run = [sorted[i]];
      while (
        i + run.length < sorted.length &&
        sorted[i + run.length].sheetRow === sorted[i].sheetRow + run.length
      ) {
        run.push(sorted[i + run.length]);
      }
      // Patch each row in the run using in-memory data
      const rowsData = run.map(({ rowIndex, fields }) => {
        const rowData = data[rowIndex] ? [...data[rowIndex]] : new Array(totalCols).fill('');
        Object.entries(fields).forEach(([key, val]) => {
          if (map[key] !== undefined) {
            rowData[map[key]] = val !== undefined && val !== null ? val : '';
          }
        });
        return rowData;
      });
      // One setValues call covers the entire contiguous run
      sheet.getRange(sorted[i].sheetRow, 1, run.length, totalCols).setValues(rowsData);
      i += run.length;
    }
  }

  /**
   * Gets recipients for a campaign with optional status filter.
   */
  function getRecipients(campaignId, statusFilter) {
    const sheet = _getSheet(TAB.RECIPIENTS);
    if (!sheet) return [];
    const map = _getColMap(TAB.RECIPIENTS);
    const data = sheet.getDataRange().getValues();
    const results = [];

    for (let i = 1; i < data.length; i++) {
      if (data[i][map['campaignId']] !== campaignId) continue;
      if (!data[i][map['email']]) continue;
      if (statusFilter && data[i][map['status']] !== statusFilter) continue;
      results.push({ rowIndex: i, data: _rowToObj(data[i], map) });
    }
    return results;
  }

  /**
   * Updates fields on a recipient row identified by campaignId + email.
   */
  function updateRecipient(campaignId, email, fields) {
    const sheet = _getSheet(TAB.RECIPIENTS);
    if (!sheet) return false;
    const map = _getColMap(TAB.RECIPIENTS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][map['campaignId']] === campaignId && data[i][map['email']] === email) {
        const rowData = [...data[i]];
        Object.entries(fields).forEach(([key, val]) => {
          if (map[key] !== undefined) {
            rowData[map[key]] = val !== undefined && val !== null ? val : '';
          }
        });
        sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);
        return true;
      }
    }
    return false;
  }

  /**
   * Bulk-cancels all PENDING recipients for a campaign.
   */
  function cancelPendingRecipients(campaignId) {
    const sheet = _getSheet(TAB.RECIPIENTS);
    if (!sheet) return 0;
    const map = _getColMap(TAB.RECIPIENTS);
    const data = sheet.getDataRange().getValues();
    const updates = [];

    for (let i = 1; i < data.length; i++) {
      if (data[i][map['campaignId']] === campaignId && data[i][map['status']] === 'PENDING') {
        updates.push({ rowIndex: i, fields: { status: 'CANCELLED' } });
      }
    }
    // Batch updates — avoids per-row API calls that exhaust the 300 calls/min quota on large campaigns
    if (updates.length > 0) bulkUpdateRecipients(updates);
    return updates.length;
  }

  // ─── _Suppression tab ──────────────────────────────────────────────────────

  /**
   * Loads entire _Suppression tab into a Set for O(1) lookup.
   */
  function getSuppressionSet() {
    const sheet = _getSheet(TAB.SUPPRESSION);
    if (!sheet) return new Set();
    const data = sheet.getDataRange().getValues();
    const set = new Set();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) set.add(String(data[i][0]).toLowerCase().trim());
    }
    return set;
  }

  /**
   * Appends a suppression row. Thread-safe via LockService.
   */
  function addSuppression(email, reason, source, method) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('Could not acquire lock for suppression write');
    try {
      const sheet = _getSheet(TAB.SUPPRESSION);
      if (!sheet) throw new Error('_Suppression tab not found');
      const normalized = String(email).toLowerCase().trim();
      // Check for existing entry (idempotent)
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]).toLowerCase().trim() === normalized) {
          log('addSuppression: already suppressed | email=' + normalized);
          return false;
        }
      }
      sheet.appendRow([normalized, reason, new Date().toISOString(), source, method]);
      log('addSuppression: added | email=' + normalized + ' reason=' + reason);
      return true;
    } finally {
      lock.releaseLock();
    }
  }

  // ─── _CampaignContent tab ──────────────────────────────────────────────────

  /**
   * Reads content for a specific campaignId + segmentId.
   */
  function getContentForSegment(campaignId, segmentId) {
    const sheet = _getSheet(TAB.CONTENT);
    if (!sheet) return null;
    const map = _getColMap(TAB.CONTENT);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][map['campaignId']] === campaignId && data[i][map['segmentId']] === segmentId) {
        return _rowToObj(data[i], map);
      }
    }
    return null;
  }

  /**
   * Writes or updates a _CampaignContent row.
   */
  function writeContent(campaignId, segmentId, content) {
    const sheet = _getSheet(TAB.CONTENT);
    if (!sheet) throw new Error('_CampaignContent tab not found');
    const map = _getColMap(TAB.CONTENT);
    const data = sheet.getDataRange().getValues();

    // Check for existing row to update
    for (let i = 1; i < data.length; i++) {
      if (data[i][map['campaignId']] === campaignId && data[i][map['segmentId']] === segmentId) {
        const fields = Object.assign({ campaignId, segmentId }, content);
        const rowData = [...data[i]];
        Object.entries(fields).forEach(([key, val]) => {
          if (map[key] !== undefined) {
            rowData[map[key]] = val !== undefined && val !== null ? val : '';
          }
        });
        sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);
        return;
      }
    }
    // Append new row
    const row = _objToRow(Object.assign({ campaignId, segmentId }, content), map, HEADERS[TAB.CONTENT]);
    sheet.appendRow(row);
  }

  // ─── _OptIn tab ────────────────────────────────────────────────────────────

  /**
   * Checks if a recipient has a valid express opt-in record.
   * Returns the consent record object or null.
   */
  function getOptInRecord(email, campaignId) {
    const sheet = _getSheet(TAB.OPT_IN);
    if (!sheet) return null;
    const map = _getColMap(TAB.OPT_IN);
    const data = sheet.getDataRange().getValues();
    const normalized = String(email).toLowerCase().trim();

    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][map['email']]).toLowerCase().trim();
      if (rowEmail !== normalized) continue;
      const consentType = data[i][map['consentType']];
      // Valid for prospect campaigns: express or express_written only
      if (!['express', 'express_written'].includes(consentType)) continue;
      const ts = data[i][map['consentTimestamp']];
      if (!ts) continue;
      // Optional campaign-scoped or global consent
      const rowCampaignId = data[i][map['campaignId']];
      if (rowCampaignId && rowCampaignId !== campaignId) continue;
      return _rowToObj(data[i], map);
    }
    return null;
  }

  // ─── Utility helpers ───────────────────────────────────────────────────────

  /**
   * Converts a sheet row (array) to a plain object using column map.
   */
  function _rowToObj(row, map) {
    const obj = {};
    Object.entries(map).forEach(([key, idx]) => {
      obj[key] = row[idx];
    });
    return obj;
  }

  /**
   * Converts a plain object to a sheet row (array) using column map and header list.
   */
  function _objToRow(obj, map, headers) {
    const row = new Array(headers.length).fill('');
    Object.entries(obj).forEach(([key, val]) => {
      if (map[key] !== undefined) {
        row[map[key]] = val !== undefined && val !== null ? val : '';
      }
    });
    return row;
  }

  module.exports = {
    ensureTabs,
    getCampaign,
    appendCampaign,
    updateCampaign,
    listCampaigns,
    appendRecipients,
    getRecipientBatch,
    bulkUpdateRecipients,
    getRecipients,
    updateRecipient,
    cancelPendingRecipients,
    getSuppressionSet,
    addSuppression,
    getContentForSegment,
    writeContent,
    getOptInRecord,
    TAB,
  };
}

__defineModule__(_main);