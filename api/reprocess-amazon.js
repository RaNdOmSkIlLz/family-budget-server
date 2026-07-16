// Manual trigger — mark emails as unread in givensbudget@gmail.com first
// Then hit: GET https://family-budget-server.vercel.app/api/reprocess-amazon
const { google } = require('googleapis');
const { appendAtFirstEmptyRow, readRange } = require('./_sheets');
const { decodeQuotedPrintable, decodeSubject, extractOrderNumber, extractOrderTotal } = require('./amazon-parsing');

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const force = (req.url || '').includes('force=1');
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    // Diagnostic: what does the server see in AmazonOrders right now?
    let sheetDiagnostic = {};
    try {
      const existingAll = await readRange('AmazonOrders!A:K');
      sheetDiagnostic = {
        sheetIdPrefix: (process.env.BUDGET_SHEET_ID || '').substring(0, 12) + '...',
        totalRows: existingAll.length,
        headerRow: existingAll[0] || null,
        orderNumbersInSheet: existingAll.slice(1).map(r => r[0]).filter(Boolean),
        lastRow: existingAll[existingAll.length - 1] || null,
      };
    } catch(e) {
      sheetDiagnostic = { error: 'Could not read AmazonOrders tab: ' + e.message };
    }

    // Search broadly — all recent emails, we filter by content below
    const searchRes = await gmail.users.messages.list({
      userId: process.env.GMAIL_ADDRESS,
      q: 'newer_than:7d',
      maxResults: 20,
    });

    const messages = searchRes.data.messages || [];
    console.log(`Found ${messages.length} recent emails (last 7 days)`);

    if (!messages.length) {
      return res.status(200).json({
        success: true,
        message: 'No emails found in the last 7 days in givensbudget@gmail.com.',
        processed: 0,
      });
    }

    // Load existing order numbers to avoid dupes
    let existingOrders = new Set();
    try {
      const existing = await readRange('AmazonOrders!A:A');
      existing.slice(1).forEach(r => { if (r[0]) existingOrders.add(r[0]); });
    } catch(e) { console.log('Could not read existing orders:', e.message); }

    const results = [];

    for (const msg of messages) {
      try {
        // Get full message
        const full = await gmail.users.messages.get({
          userId: process.env.GMAIL_ADDRESS,
          id: msg.id,
          format: 'full',
        });

        const headers = full.data.payload?.headers || [];
        const from    = headers.find(h => h.name === 'From')?.value || '';
        const rawSubj = headers.find(h => h.name === 'Subject')?.value || '';
        const date    = headers.find(h => h.name === 'Date')?.value || '';
        const subject = decodeSubject(rawSubj);

        // Only process Amazon emails
        const isAmazon = from.toLowerCase().includes('amazon.com') ||
                         subject.toLowerCase().includes('amazon') ||
                         subject.toLowerCase().includes('ordered:');
        if (!isAmazon) {
          console.log(`Skipping non-Amazon: ${subject}`);
          continue;
        }

        const isReturn = from.includes('return@amazon.com') || from.includes('refund@amazon.com') ||
                         subject.toLowerCase().includes('return request') ||
                         subject.toLowerCase().includes('refund') ||
                         subject.toLowerCase().includes('returned');

        // Extract body
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

        // Find ALL order numbers in this email (Amazon sometimes combines multiple orders)
        const allOrderNums = [...new Set(
          [...(bodyText + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
        )];
        console.log(`Found orders: ${allOrderNums.join(', ')}`);

        // Order confirmations without a parseable order number aren't very
        // actionable, so those are still skipped. Returns/refunds are different —
        // they often don't restate the order number in the same format, so give
        // them a stable fallback identifier instead of dropping them entirely.
        if (!allOrderNums.length && !isReturn) {
          results.push({ subject, status: 'skipped — no order number' });
          continue;
        }
        const effectiveOrderNums = allOrderNums.length ? allOrderNums : ['REFUND-' + subject.replace(/[^a-zA-Z0-9]/g, '').substring(0, 24)];

        const orderDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        // Extract all grand totals — one per order
        const totalPattern = /grand total[:\s]*\$?\s*([0-9,]+\.[0-9]{1,2})/gi;
        const allTotals = [...bodyText.matchAll(totalPattern)].map(m => parseFloat(m[1].replace(/,/g, '')));
        console.log(`Found totals: ${allTotals.join(', ')}`);

        const itemName = subject
          .replace(/^ordered:\s*/i, '')
          .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '')
          .replace(/^\d+\s+/, '')
          .trim() || '[Item — see order]';

        for (let oi = 0; oi < effectiveOrderNums.length; oi++) {
          const num = effectiveOrderNums[oi];
          const total = allTotals[oi] !== undefined ? allTotals[oi] : (allTotals[0] || null);

          if (existingOrders.has(num) && !force) {
            results.push({ subject, orderNumber: num, status: 'already in sheet (use ?force=1 to rewrite)' });
            continue;
          }

          const rows = [[
            num, orderDate, isReturn ? 'return' : 'order',
            '', itemName,
            total || 0, 0, total || 0,
            '', isReturn ? 'returned' : 'pending', isReturn && !allOrderNums.length ? 'no_matching_order' : '',
          ]];

          await appendAtFirstEmptyRow('AmazonOrders', rows);
          existingOrders.add(num);
          console.log(`Wrote order ${num}: ${itemName} $${total}`);
          results.push({ subject, orderNumber: num, total, status: 'written to sheet' });
        }

        // Mark as read after all orders from this email processed
        await gmail.users.messages.modify({
          userId: process.env.GMAIL_ADDRESS,
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      } catch(e) {
        console.error(`Error processing message ${msg.id}:`, e.message);
        results.push({ id: msg.id, status: 'error: ' + e.message });
      }
    }

    return res.status(200).json({
      success: true,
      processed: results.filter(r => r.status === 'written to sheet').length,
      sheetDiagnostic,
      results,
    });
  } catch(e) {
    console.error('Reprocess error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
