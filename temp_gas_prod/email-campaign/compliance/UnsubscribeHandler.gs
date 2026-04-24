function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const ConfigManager = require('common-js/ConfigManager');
  const { addSuppression } = require('email-campaign/compliance/SuppressionList');
  const { updateRecipient } = require('email-campaign/storage/CampaignStorage');

  // Email regex for input sanitization
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Characters that could trigger formula injection if written to a cell
  const FORMULA_INJECTION_PREFIXES = ['=', '+', '-', '@'];

  /**
   * Handles GET requests — link-based unsubscribe from email footer.
   * URL params: ?action=unsubscribe&email=BASE64&campaign=ID&token=HMAC
   *
   * Returns HtmlOutput or null (null = this handler doesn't own this request).
   */
  function doGetHandler(e) {
    const params = (e && e.parameter) || {};
    if (params.action !== 'unsubscribe') return null; // Not ours — let other handlers run

    log('UnsubscribeHandler.doGet | params=' + JSON.stringify(params));

    const encodedEmail = params.email;
    const campaignId = params.campaign;
    const token = params.token;

    if (!encodedEmail || !campaignId || !token) {
      return _renderPage('Error', 'This unsubscribe link is invalid or has expired.', '#c0392b');
    }

    // Decode and sanitize email
    let email;
    try {
      email = Utilities.newBlob(Utilities.base64Decode(encodedEmail)).getDataAsString();
    } catch (e) {
      return _renderPage('Error', 'This unsubscribe link is invalid or has expired.', '#c0392b');
    }

    // Input sanitization: verify email format and reject formula injection attempts
    if (!EMAIL_REGEX.test(email)) {
      return _renderPage('Error', 'This unsubscribe link is invalid or has expired.', '#c0392b');
    }
    if (FORMULA_INJECTION_PREFIXES.includes(email.charAt(0))) {
      log('[WARN] Formula injection attempt detected in email: ' + email);
      return _renderPage('Error', 'This unsubscribe link is invalid or has expired.', '#c0392b');
    }

    // Validate HMAC token
    if (!_validateToken(email, campaignId, token)) {
      return _renderPage('Error', 'This unsubscribe link is invalid or has expired.', '#c0392b');
    }

    // Process unsubscribe (idempotent)
    const result = _processUnsubscribe(email, campaignId, 'link');

    if (result.alreadySuppressed) {
      return _renderPage('Already Unsubscribed', 'This email address was already removed from our list.', '#7f8c8d');
    }

    log('UnsubscribeHandler.doGet: successfully unsubscribed | email=' + email);
    return _renderPage('Unsubscribed', 'You have been successfully unsubscribed and will no longer receive emails from this campaign.', '#27ae60');
  }

  /**
   * Handles POST requests — RFC 8058 one-click unsubscribe.
   * Gmail/Yahoo/Outlook send: POST body = "List-Unsubscribe=One-Click"
   *
   * Returns ContentService output or null.
   */
  function doPostHandler(e) {
    const params = (e && e.parameter) || {};
    const postData = (e && e.postData && e.postData.contents) || '';

    // RFC 8058: body should contain "List-Unsubscribe=One-Click"
    // Some clients also send as query params
    const isOneClick = postData.includes('List-Unsubscribe=One-Click') ||
                       params['List-Unsubscribe'] === 'One-Click';

    let email = params.email || params['email'];
    const campaignId = params.campaign || params['campaign'];
    const token = params.token || params['token'];

    if (!isOneClick && !email) return null; // Not ours
    // One-click POST missing all identifiable params cannot be processed — pass to other handlers
    if (isOneClick && !email && !campaignId && !token) return null;

    // The unsubscribe URL base64-encodes the email (same format as GET handler).
    // Try to decode it so HMAC validation succeeds (S12 — RFC 8058 one-click fix).
    if (email) {
      try {
        const decoded = Utilities.newBlob(Utilities.base64Decode(email)).getDataAsString();
        if (EMAIL_REGEX.test(decoded)) email = decoded;
      } catch (e) { /* not base64 — use raw value */ }
    }

    log('UnsubscribeHandler.doPost | email=' + email + ' campaign=' + campaignId);

    // MODIFIED: token now required unconditionally — see Phase 2b HMAC fix
    // EmailSender embeds HMAC token in List-Unsubscribe URL; legitimate RFC 8058 POSTs include it.
    if (!email || !campaignId || !token) {
      return ContentService.createTextOutput('{"status":"error","message":"Missing required parameters"}')
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Sanitize email
    if (!EMAIL_REGEX.test(email)) {
      return ContentService.createTextOutput('{"status":"error","message":"Invalid email"}')
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (!_validateToken(email, campaignId, token)) {
      return ContentService.createTextOutput('{"status":"error","message":"Invalid token"}')
        .setMimeType(ContentService.MimeType.JSON);
    }

    _processUnsubscribe(email, campaignId, 'one-click');
    log('UnsubscribeHandler.doPost: processed | email=' + email);

    return ContentService.createTextOutput('{"status":"ok","message":"Unsubscribed"}')
      .setMimeType(ContentService.MimeType.JSON);
  }

  /**
   * Generates an HMAC-SHA256 token for email + campaignId.
   * IMPORTANT: Tokens do not expire — rotating UNSUBSCRIBE_SECRET invalidates all
   * existing footer links in sent emails. Only rotate if the secret is compromised.
   * WARNING: rotating UNSUBSCRIBE_SECRET invalidates all existing unsubscribe links.
   */
  function generateToken(email, campaignId) {
    const secret = _getSecret();
    const payload = email + ':' + campaignId;
    const signature = Utilities.computeHmacSha256Signature(payload, secret);
    return Utilities.base64EncodeWebSafe(signature);
  }

  /**
   * Validates an HMAC token using constant-time comparison to prevent timing attacks.
   * Returns true if valid.
   */
  function _validateToken(email, campaignId, token) {
    try {
      const expected = generateToken(email, campaignId);
      // Constant-time XOR comparison — prevents timing side-channel attacks (S11)
      if (expected.length !== token.length) return false;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
      }
      return diff === 0;
    } catch (e) {
      log('[WARN] Token validation error: ' + e.message);
      return false;
    }
  }

  /**
   * Core unsubscribe processing. Adds to suppression list and updates _Recipients.
   * @returns {{ alreadySuppressed: boolean }}
   */
  function _processUnsubscribe(email, campaignId, method) {
    const source = 'campaign:' + campaignId;
    const added = addSuppression(email, 'unsubscribe', source, method);

    // Always update recipient row — it may still be in a non-terminal state
    // even if this email was already suppressed via another path
    try {
      const updated = updateRecipient(campaignId, email, {
        status: 'UNSUBSCRIBED',
        unsubscribedAt: new Date().toISOString()
      });
      if (!updated) {
        log('[WARN] _processUnsubscribe: recipient row not found | campaign=' + campaignId + ' email=' + email);
      }
    } catch (e) {
      log('[WARN] Could not update recipient status: ' + e.message);
    }

    return { alreadySuppressed: !added };
  }

  /**
   * Retrieves UNSUBSCRIBE_SECRET from ConfigManager.
   */
  function _getSecret() {
    const cm = new ConfigManager('CAMPAIGN');
    const secret = cm.get('UNSUBSCRIBE_SECRET', null);
    if (!secret) throw new Error('UNSUBSCRIBE_SECRET not set in ConfigManager');
    return secret;
  }

  /**
   * Renders a simple, accessible HTML page for unsubscribe results.
   * Accessibility: lang="en", <h1> heading, sufficient contrast.
   */
  function _renderPage(title, message, color) {
    // Validate color is a safe hex value before CSS injection; fallback to neutral grey
    const safeColor = /^#[0-9a-fA-F]{3,6}$/.test(color) ? color : '#333333';
    const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${_escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 8px; padding: 40px; max-width: 480px;
            text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: ${safeColor}; margin-top: 0; }
    p { color: #333; line-height: 1.5; }
  </style>
  </head>
  <body>
  <div class="card">
    <h1>${_escapeHtml(title)}</h1>
    <p>${_escapeHtml(message)}</p>
  </div>
  </body>
  </html>`;
    return HtmlService.createHtmlOutput(html).setTitle(title);
  }

  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  module.exports = { doGetHandler, doPostHandler, generateToken };
}

__defineModule__(_main);