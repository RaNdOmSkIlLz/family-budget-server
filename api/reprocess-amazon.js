// Manual trigger for reprocessing Amazon emails — calls the EXACT same
// processMessage() the live webhook uses (tax distribution, per-order-block
// parsing, image extraction, stage-aware returns), so results always match
// what amazon-webhook.js would have produced.
//
// Supports scoping a rebuild to only orders placed on/after a given date —
// this matters because a return/shipment email can arrive weeks after its
// original order, so a simple "only search recent emails" filter isn't
// enough to exclude an old order's return. Instead this does two passes:
//   1. Peek every candidate email (cheap — no writes) to find which order
//      numbers actually belong to an 'order' email dated on/after `since`.
//   2. Only fully process (write to the sheet) emails whose order number is
//      in that in-scope set — anything belonging to an older, excluded
//      order is skipped even if the email itself arrived recently.
//
// Usage:
//   GET /api/reprocess-amazon?since=2026-07-01           — only orders from this date on
//   GET /api/reprocess-amazon?since=2026-07-01&days=120  — how far back to search for candidate emails
//   GET /api/reprocess-amazon?limit=15                    — batch size per call
//   GET /api/reprocess-amazon?since=...&pageToken=XXXX    — continue a previous run
//
// For a full rebuild scoped to recent orders: clear the AmazonOrders tab
// first (manually, in Google Sheets), then call this repeatedly with the
// same `since` value and the returned nextPageToken, until "hasMore: false".
const { google } = require('googleapis');
const { readRange } = require('./_sheets');
const { processMessage, getGmailAuth } = require('./amazon-webhook');
const { decodeQuotedPrintable, decodeSubject, detectEmailType, extractOrderNumber } = require('./amazon-parsing');

async function peekMessage(gmail, msgId) {
  const full = await gmail.users.messages.get({
    userId: process.env.GMAIL_ADDRESS,
    id: msgId,
    format: 'full',
  });
  const headers = full.data.payload?.headers || [];
  const from = headers.find(h => h.name === 'From')?.value || '';
  const rawSubj = headers.find(h => h.name === 'Subject')?.value || '';
  const dateHeader = headers.find(h => h.name === 'Date')?.value || '';
  const subject = decodeSubject(rawSubj);

  let bodyText = '';
  const extractBody = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
      bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    (part.parts || []).forEach(extractBody);
  };
  extractBody(full.data.payload);
  bodyText = decodeQuotedPrintable(bodyText);

  const emailType = detectEmailType(from, subject, bodyText);
  const allOrderNumbers = [...new Set(
    [...(bodyText + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
  )];
  const emailDate = dateHeader ? new Date(dateHeader) : null;

  return { emailType, allOrderNumbers, emailDate, subject };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, 'http://x');
    const sinceParam = url.searchParams.get('since'); // e.g. 2026-07-01
    const since = sinceParam ? new Date(sinceParam + 'T00:00:00') : null;
    const days = parseInt(url.searchParams.get('days') || '120', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10), 50);
    const pageToken = url.searchParams.get('pageToken') || undefined;

    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    let sheetDiagnostic = {};
    try {
      const existingAll = await readRange('AmazonOrders!A:K');
      sheetDiagnostic = {
        totalRows: existingAll.length,
        distinctOrderNumbers: [...new Set(existingAll.slice(1).map(r => r[0]).filter(Boolean))].length,
      };
    } catch(e) {
      sheetDiagnostic = { error: 'Could not read AmazonOrders tab: ' + e.message };
    }

    const searchRes = await gmail.users.messages.list({
      userId: process.env.GMAIL_ADDRESS,
      q: `(from:(amazon.com) OR subject:(amazon OR "ordered:" OR "shipped:" OR "delivered:")) newer_than:${days}d`,
      maxResults: limit,
      pageToken,
    });

    const messages = searchRes.data.messages || [];
    const nextPageToken = searchRes.data.nextPageToken || null;

    if (!messages.length) {
      return res.status(200).json({
        success: true, message: `No emails found in the last ${days} days.`,
        processed: 0, hasMore: false, sheetDiagnostic,
      });
    }

    // Pass 1: peek every message in this batch (no writes yet)
    const peeked = [];
    for (const msg of messages) {
      try {
        const info = await peekMessage(gmail, msg.id);
        peeked.push({ id: msg.id, ...info });
      } catch(e) {
        peeked.push({ id: msg.id, error: e.message });
      }
    }

    // Build the in-scope order-number set from 'order' emails dated on/after `since`
    const inScopeOrders = new Set();
    if (since) {
      peeked.forEach(p => {
        if (p.emailType === 'order' && p.emailDate && p.emailDate >= since) {
          p.allOrderNumbers.forEach(n => inScopeOrders.add(n));
        }
      });
    }

    // Pass 2: only fully process (write) messages that qualify
    const results = [];
    for (const p of peeked) {
      if (p.error) { results.push({ id: p.id, status: 'error: ' + p.error }); continue; }
      if (!p.emailType) { results.push({ id: p.id, subject: p.subject, status: 'skipped — not an Amazon email' }); continue; }

      if (since) {
        const isOrderInWindow = p.emailType === 'order' && p.emailDate && p.emailDate >= since;
        const belongsToInScopeOrder = p.allOrderNumbers.some(n => inScopeOrders.has(n));
        if (!isOrderInWindow && !belongsToInScopeOrder) {
          results.push({ id: p.id, subject: p.subject, orderNumbers: p.allOrderNumbers, status: `skipped — order predates ${sinceParam}` });
          continue;
        }
      }

      try {
        await processMessage(gmail, p.id);
        results.push({ id: p.id, subject: p.subject, orderNumbers: p.allOrderNumbers, status: 'processed' });
      } catch(e) {
        results.push({ id: p.id, subject: p.subject, status: 'error: ' + e.message });
      }
    }

    return res.status(200).json({
      success: true,
      since: sinceParam || '(no filter — all orders in range)',
      inScopeOrderCount: since ? inScopeOrders.size : null,
      inScopeOrders: since ? [...inScopeOrders] : null,
      processed: results.filter(r => r.status === 'processed').length,
      skipped: results.filter(r => r.status.startsWith('skipped')).length,
      errors: results.filter(r => r.status.startsWith('error')).length,
      hasMore: !!nextPageToken,
      nextPageToken,
      sheetDiagnostic,
      results,
    });
  } catch(e) {
    console.error('Reprocess error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
