function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const ConfigManager = require('common-js/ConfigManager');
  const { generateToken } = require('email-campaign/compliance/UnsubscribeHandler');


  /**
   * Sends a single campaign email to one recipient.
   * Builds raw RFC 5322 MIME with multipart/alternative and required compliance headers.
   *
   * @param {Object} campaign  - Campaign row object (needs campaignId, senderEmail, senderName,
   *                             replyTo, physicalAddress)
   * @param {Object} recipient - Recipient row object (needs email, channelAddress)
   * @param {Object} content   - { subject, htmlBody, textBody }
   * @returns {{ status: 'SENT'|'FAILED', messageId, gmailMessageId, threadId, error? }}
   */
  function send(campaign, recipient, content) {
    try {
      const cm = new ConfigManager('CAMPAIGN');
      const webAppUrl = cm.get('WEB_APP_URL', '');
      // WEB_APP_URL must be set: new ConfigManager('CAMPAIGN').set('WEB_APP_URL', scriptUrl)
      // Empty string → relative URL (?action=unsubscribe...) invalid in email; CAN-SPAM violation.
      if (!webAppUrl) {
        log('[WARN] EmailSender.send: WEB_APP_URL not configured — unsubscribe links will be malformed');
      }

      const email = recipient.channelAddress || recipient.email;
      const token = generateToken(email, campaign.campaignId);
      const encodedEmail = Utilities.base64EncodeWebSafe(Utilities.newBlob(email).getBytes());
      const unsubscribeUrl = webAppUrl + '?action=unsubscribe' +
        '&email=' + encodedEmail +
        '&campaign=' + encodeURIComponent(campaign.campaignId) +
        '&token=' + encodeURIComponent(token);

      // RFC 8058: List-Unsubscribe-Post header triggers one-click unsubscribe in Gmail/Yahoo/Outlook
      // Include both mailto: (fallback) and https: (preferred for RFC 8058 POST)
      const listUnsubscribePost = 'List-Unsubscribe=One-Click';
      const listUnsubscribe = '<' + unsubscribeUrl + '>';

      const messageId = _generateMessageId();
      const boundary = 'boundary_' + Utilities.getUuid().replace(/-/g, '');
      const now = new Date();

      // Build the unsubscribe footer for both text and HTML
      const textFooter = '\n\n--\nTo unsubscribe: ' + unsubscribeUrl + '\n' +
        (campaign.physicalAddress || '');
      const htmlFooter = '<br><br><hr style="border:none;border-top:1px solid #eee;margin:20px 0">' +
        '<p style="font-size:12px;color:#999;text-align:center">' +
        '<a href="' + _escapeAttr(unsubscribeUrl) + '">Unsubscribe</a> | ' +
        _escapeHtml(campaign.physicalAddress || '') +
        '</p>';

      // Assemble display-name address fields with RFC 2047 encoding for non-ASCII names.
      // Encoded words must NOT appear inside quoted strings (RFC 2047 §5), so we use
      // quoted form for pure-ASCII names and bare encoded-word form for non-ASCII.
      const _fmtAddr = (name, addr) => {
        const safe = _sanitizeHeaderValue(name);
        const enc  = _encodeMimeHeader(safe);
        return enc === safe ? '"' + safe + '" <' + addr + '>' : enc + ' <' + addr + '>';
      };
      const toField   = recipient.firstName ? _fmtAddr(recipient.firstName,   email)                : email;
      const fromField = campaign.senderName ? _fmtAddr(campaign.senderName, campaign.senderEmail) : campaign.senderEmail;

      // Build raw MIME message
      const rawLines = [
        'From: ' + fromField,
        'To: ' + toField,
        'Subject: ' + _encodeMimeHeader(content.subject),
        'Message-ID: ' + messageId,
        'Date: ' + now.toUTCString(),
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' + boundary + '"',
        'List-Unsubscribe: ' + listUnsubscribe,
        'List-Unsubscribe-Post: ' + listUnsubscribePost,
        'X-Campaign-ID: ' + campaign.campaignId,
      ];

      if (campaign.replyTo) rawLines.push('Reply-To: ' + campaign.replyTo);

      rawLines.push('', // blank line before body
        '--' + boundary,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        _quotedPrintable((content.textBody || _htmlToText(content.htmlBody)) + textFooter),
        '',
        '--' + boundary,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        _quotedPrintable(content.htmlBody + htmlFooter),
        '',
        '--' + boundary + '--',
      );

      const raw = Utilities.base64EncodeWebSafe(rawLines.join('\r\n'));

      // Send via Gmail Advanced Service
      const response = Gmail.Users.Messages.send({ raw }, 'me');

      log('EmailSender.send: SENT | to=' + email + ' msgId=' + messageId +
          ' gmailId=' + response.id + ' threadId=' + response.threadId);

      return {
        status:       'SENT',
        messageId,
        gmailMessageId: response.id,
        threadId:     response.threadId,
      };

    } catch (err) {
      log('[ERROR] EmailSender.send: ' + err.message + ' | to=' + (recipient.email || '?'));
      return {
        status: 'FAILED',
        error:  err.message,
      };
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Generates a unique RFC 5322 Message-ID using the sender domain if available.
   */
  function _generateMessageId() {
    const uuid = Utilities.getUuid().replace(/-/g, '');
    const domain = 'mail.google.com';
    return '<' + uuid + '@' + domain + '>';
  }

  /**
   * Encodes a header value for non-ASCII characters using RFC 2047 encoded-word format.
   * Passes through pure ASCII headers unchanged.
   */
  function _encodeMimeHeader(text) {
    // If all ASCII, no encoding needed
    if (/^[\x00-\x7F]*$/.test(text)) return text;
    // RFC 2047: =?UTF-8?B?<base64>?=
    return '=?UTF-8?B?' + Utilities.base64Encode(text) + '?=';
  }

  /**
   * Basic quoted-printable encoding — encodes non-ASCII and control chars.
   * Operates on UTF-8 bytes (not JS charCodes) so multi-byte chars encode correctly.
   * Lines are wrapped at 76 chars per RFC 2045.
   */
  function _quotedPrintable(text) {
    // Get actual UTF-8 bytes (GAS returns signed bytes — normalize to unsigned)
    const bytes = Utilities.newBlob(text).getBytes();
    let encoded = '';
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      if (code === 13) {
        // CR — check for CRLF pair
        if (i + 1 < bytes.length) {
          const next = bytes[i + 1] < 0 ? bytes[i + 1] + 256 : bytes[i + 1];
          if (next === 10) i++; // consume LF
        }
        encoded += '\r\n';
      } else if (code === 10) {
        encoded += '\r\n';
      } else if (code === 61 || code > 126 || (code < 32 && code !== 9)) {
        // Encode =, non-printable, non-ASCII
        encoded += '=' + ('0' + code.toString(16).toUpperCase()).slice(-2);
      } else {
        encoded += String.fromCharCode(code);
      }
    }
    // Soft line wrapping at 76 chars
    const lines = encoded.split('\r\n');
    return lines.map(line => {
      if (line.length <= 76) return line;
      const wrapped = [];
      while (line.length > 76) {
        // Don't split a =XX encoded sequence at the wrap boundary
        let cutAt = 75;
        if (line[cutAt - 1] === '=') cutAt--;
        else if (cutAt >= 2 && line[cutAt - 2] === '=') cutAt -= 2;
        wrapped.push(line.substring(0, cutAt) + '=');
        line = line.substring(cutAt);
      }
      wrapped.push(line);
      return wrapped.join('\r\n');
    }).join('\r\n');
  }

  /**
   * Strips HTML tags to produce a minimal plain-text fallback.
   */
  function _htmlToText(html) {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  /** Strips CRLF from display-name values before inserting into raw MIME headers. */
  function _sanitizeHeaderValue(str) {
    return String(str || '').replace(/[\r\n]+/g, ' ').trim();
  }

  function _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _escapeAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  module.exports = { send };
}

__defineModule__(_main);