// Manual trigger — mark emails as unread in givensbudget@gmail.com first
// Then hit: GET https://family-budget-server.vercel.app/api/reprocess-amazon
const { google } = require('googleapis');
const { appendAtFirstEmptyRow, readRange } = require('./_sheets');

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}

function decodeSubject(raw) {
  return raw.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, encoded) => {
    try {
      return enc.toUpperCase() === 'B'
        ? Buffer.from(encoded, 'base64').toString('utf8')
        : encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16)));
    } catch(e) { return raw; }
  });
}

function extractOrderNumber(text) {
  const m = text.match(/([0-9]{3}-[0-9]{7}-[0-9]{7})/);
  return m ? m[1] : null;
}

function extractOrderTotal(text) {
  const patterns = [
    /order total[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
    /grand total[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
    /total[:\s]*\$([0-9,]+\.[0-9]{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
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

        const isReturn = from.includes('return@amazon.com') ||
                         subject.toLowerCase().includes('return request');

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

        // Find ALL order numbers in this email (Amazon sometimes combines multiple orders)
        const allOrderNums = [...new Set(
          [...(bodyText + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
        )];
        console.log(`Found orders: ${allOrderNums.join(', ')}`);

        if (!allOrderNums.length) {
          results.push({ subject, status: 'skipped — no order number' });
          continue;
        }

        const orderDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        // Extract all grand totals — one per order
        const totalPattern = /grand total[:\s]*\$?\s*([0-9,]+\.[0-9]{2})/gi;
        const allTotals = [...bodyText.matchAll(totalPattern)].map(m => parseFloat(m[1].replace(/,/g, '')));
        console.log(`Found totals: ${allTotals.join(', ')}`);

        const itemName = subject
          .replace(/^ordered:\s*/i, '')
          .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '')
          .replace(/^\d+\s+/, '')
          .trim() || '[Item — see order]';

        for (let oi = 0; oi < allOrderNums.length; oi++) {
          const num = allOrderNums[oi];
          const total = allTotals[oi] !== undefined ? allTotals[oi] : (allTotals[0] || null);

          if (existingOrders.has(num) && !force) {
            results.push({ subject, orderNumber: num, status: 'already in sheet (use ?force=1 to rewrite)' });
            continue;
          }

          const rows = [[
            num, orderDate, isReturn ? 'return' : 'order',
            '', itemName,
            total || 0, 0, total || 0,
            '', 'pending', '',
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
