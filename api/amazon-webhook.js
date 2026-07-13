const { google } = require('googleapis');
const { appendRange, readRange, clearAndWrite } = require('./_sheets');

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}

// ── EMAIL TYPE DETECTION ──────────────────────────────────────────────────────
function detectEmailType(from, subject, bodyText) {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  const b = (bodyText || '').toLowerCase().substring(0, 2000); // check first 2000 chars

  // Check if body contains Amazon sender (handles forwarded emails)
  const bodyHasAmazon = b.includes('auto-confirm@amazon.com') ||
    b.includes('amazon.com/gp/css/order') ||
    b.includes('amazon.com order') ||
    b.includes('your amazon.com order') ||
    b.includes('order confirmation') && b.includes('amazon');

  const isOrder = f.includes('auto-confirm@amazon.com') ||
    s.includes('your amazon.com order') ||
    s.includes('order confirmation') ||
    (s.includes('fwd') && bodyHasAmazon) ||
    (s.includes('fw:') && bodyHasAmazon) ||
    bodyHasAmazon;

  const isReturn = f.includes('return@amazon.com') ||
    s.includes('return') && (f.includes('amazon') || bodyHasAmazon) ||
    s.includes('refund') && (f.includes('amazon') || bodyHasAmazon);

  if (isReturn) return 'return';
  if (isOrder) return 'order';
  return null;
}

// ── ORDER NUMBER EXTRACTION ───────────────────────────────────────────────────
function extractOrderNumber(text) {
  const m = text.match(/([0-9]{3}-[0-9]{7}-[0-9]{7})/);
  return m ? m[1] : null;
}

// ── ORDER TOTAL EXTRACTION ────────────────────────────────────────────────────
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

// ── TAX EXTRACTION ────────────────────────────────────────────────────────────
function extractTax(text) {
  const patterns = [
    /estimated tax[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
    /sales tax[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
    /tax[:\s]*\$([0-9,]+\.[0-9]{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return 0;
}

// ── ITEM EXTRACTION ───────────────────────────────────────────────────────────
function extractItems(text) {
  const items = [];
  const cleaned = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/\s+/g, ' ');

  const lines = cleaned.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 3);
  lines.forEach(line => {
    if (/^(shipping|handling|estimated tax|sales tax|tax|total|subtotal|discount|promotion|gift card|order|items|qty|quantity|sold by|condition)/i.test(line)) return;
    const priceMatch = line.match(/\$([0-9]+\.[0-9]{2})/);
    if (priceMatch) {
      const price = parseFloat(priceMatch[1]);
      const name = line.replace(/\$[0-9]+\.[0-9]{2}.*/, '').trim().replace(/^[-•*\s]+/, '');
      if (price > 0.50 && price < 2000 && name.length > 5 && name.length < 150) {
        items.push({name: name.substring(0, 100), listPrice: price});
      }
    }
  });

  // Deduplicate by name
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.name)) return false; seen.add(i.name); return true; });
}

// ── PROPORTIONAL TAX SPLIT ────────────────────────────────────────────────────
function applyTaxProportionally(items, totalTax) {
  if (!totalTax || !items.length) return items.map(i => ({...i, taxShare: 0, totalPrice: i.listPrice}));
  const subtotal = items.reduce((s, i) => s + i.listPrice, 0);
  return items.map(item => {
    const taxShare = subtotal > 0 ? parseFloat(((item.listPrice / subtotal) * totalTax).toFixed(2)) : 0;
    return {...item, taxShare, totalPrice: parseFloat((item.listPrice + taxShare).toFixed(2))};
  });
}

// ── WRITE ORDER TO SHEET ──────────────────────────────────────────────────────
async function writeOrderToSheet(orderNumber, orderDate, emailType, items, orderTotal, mismatch) {
  const rows = items.map(item => [
    orderNumber, orderDate, emailType,
    '',                    // PlaidTxnId
    item.name,
    item.listPrice,
    item.taxShare || 0,
    item.totalPrice || item.listPrice,
    '',                    // Category
    'pending',             // Status
    mismatch || '',        // Mismatch delta
  ]);
  await appendRange('AmazonOrders!A:K', rows);
  console.log(`Wrote ${rows.length} items for order ${orderNumber}`);
}

// ── HANDLE RETURN ─────────────────────────────────────────────────────────────
async function handleReturn(orderNumber, returnedItems) {
  try {
    const rows = await readRange('AmazonOrders!A:K');
    if (rows.length < 2) return;
    const header = rows[0];
    const data = rows.slice(1);
    const updated = data.map(row => {
      if (row[0] !== orderNumber) return row;
      const isReturned = returnedItems.some(ri =>
        row[4] && ri.name && row[4].toLowerCase().includes(ri.name.toLowerCase().substring(0, 15))
      );
      if (isReturned) { const r = [...row]; r[9] = 'returned'; return r; }
      return row;
    });
    const allReturned = updated.filter(r => r[0] === orderNumber && r[2] === 'order').every(r => r[9] === 'returned');
    if (allReturned) updated.forEach(r => { if (r[0] === orderNumber) r[9] = 'fully_returned'; });
    await clearAndWrite('AmazonOrders!A1', [header, ...updated]);
    console.log(`Return processed for ${orderNumber}`);
  } catch(e) { console.error('Handle return error:', e.message); }
}

// ── PROCESS A SINGLE MESSAGE ──────────────────────────────────────────────────
async function processMessage(gmail, msgId) {
  const msg = await gmail.users.messages.get({
    userId: process.env.GMAIL_ADDRESS,
    id: msgId,
    format: 'full',
  });

  const headers = msg.data.payload?.headers || [];
  const from    = headers.find(h => h.name === 'From')?.value || '';
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const date    = headers.find(h => h.name === 'Date')?.value || '';

  console.log(`Processing: "${subject}" from "${from}"`);

  // Extract body text first so we can pass it to detectEmailType
  let bodyText = '';
  const extractBody = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
      bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    (part.parts || []).forEach(extractBody);
  };
  extractBody(msg.data.payload);

  const emailType = detectEmailType(from, subject, bodyText);
  if (!emailType) { console.log('Not an Amazon receipt, skipping'); return; }

  const orderNumber = extractOrderNumber(bodyText + ' ' + subject);
  if (!orderNumber) { console.log('Could not extract order number from:', subject); return; }

  const orderDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  if (emailType === 'order') {
    const items = extractItems(bodyText);
    const tax = extractTax(bodyText);
    const orderTotal = extractOrderTotal(bodyText);
    const itemsWithTax = applyTaxProportionally(items, tax);
    const itemsTotal = parseFloat(itemsWithTax.reduce((s, i) => s + (i.totalPrice || i.listPrice), 0).toFixed(2));
    const mismatch = orderTotal && Math.abs(orderTotal - itemsTotal) > 0.02
      ? parseFloat(Math.abs(orderTotal - itemsTotal).toFixed(2))
      : null;

    if (mismatch) console.log(`Mismatch for ${orderNumber}: order=$${orderTotal}, items=$${itemsTotal}, delta=$${mismatch}`);

    const finalItems = items.length ? itemsWithTax : [{
      name: '[Items not parsed — check email]',
      listPrice: orderTotal || 0, taxShare: 0, totalPrice: orderTotal || 0
    }];

    await writeOrderToSheet(orderNumber, orderDate, 'order', finalItems, orderTotal, mismatch || '');

  } else if (emailType === 'return' || emailType === 'refund') {
    const returnedItems = extractItems(bodyText);
    await handleReturn(orderNumber, returnedItems);
  }

  // Mark as read
  await gmail.users.messages.modify({
    userId: process.env.GMAIL_ADDRESS,
    id: msgId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

// ── MAIN WEBHOOK ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = req.body || {};
    const messageData = body.message?.data;
    if (!messageData) { console.log('No message data'); return res.status(200).end(); }

    const decoded = Buffer.from(messageData, 'base64').toString('utf8');
    const notification = JSON.parse(decoded);
    console.log('Notification:', JSON.stringify(notification));

    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    // Use the notification's historyId to find new messages
    const startHistoryId = String(parseInt(notification.historyId) - 1);
    console.log('historyId from notification:', notification.historyId, 'using startHistoryId:', startHistoryId);

    let messageIds = [];

    try {
      const historyResponse = await gmail.users.history.list({
        userId: process.env.GMAIL_ADDRESS,
        startHistoryId,
        historyTypes: ['messageAdded'],
      });

      const history = historyResponse.data.history || [];
      history.forEach(h => {
        (h.messagesAdded || []).forEach(m => {
          if (!messageIds.includes(m.message.id)) messageIds.push(m.message.id);
        });
      });
      console.log(`Found ${messageIds.length} messages in history`);
    } catch(histErr) {
      console.error('History list error:', histErr.message);
    }

    // Diagnostic — list all recent messages to see what's in the account
    try {
      const allRes = await gmail.users.messages.list({
        userId: process.env.GMAIL_ADDRESS,
        maxResults: 5,
      });
      console.log(`Diagnostic: ${(allRes.data.messages || []).length} total recent messages in account`);
      (allRes.data.messages || []).forEach(m => console.log('  msg id:', m.id));
    } catch(e) { console.error('Diagnostic search error:', e.message); }

    // Always also run search as safety net — catches anything history missed
    try {
      const searchRes = await gmail.users.messages.list({
        userId: process.env.GMAIL_ADDRESS,
        q: 'from:(auto-confirm@amazon.com OR return@amazon.com OR refund@amazon.com) newer_than:1d',
        maxResults: 10,
      });
      const searchIds = (searchRes.data.messages || []).map(m => m.id);
      console.log(`Found ${searchIds.length} messages via search`);
      searchIds.forEach(id => { if (!messageIds.includes(id)) messageIds.push(id); });
    } catch(searchErr) {
      console.error('Search error:', searchErr.message);
    }

    // Verify messages exist and are accessible before processing
    const verifiedIds = [];
    for (const msgId of messageIds) {
      try {
        // Use metadata format first — lightweight check
        const meta = await gmail.users.messages.get({
          userId: process.env.GMAIL_ADDRESS,
          id: msgId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = meta.data.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        console.log(`Message ${msgId}: from="${from}" subject="${subject}"`);
        // Only process Amazon emails — pass empty body since we only have metadata here
        // Full body check happens in processMessage
        if (detectEmailType(from, subject, '') || subject.toLowerCase().includes('fwd') || subject.toLowerCase().includes('fw:')) {
          verifiedIds.push(msgId);
          console.log(`Queued for processing: ${subject}`);
        } else {
          console.log(`Skipping non-Amazon message: ${subject}`);
        }
      } catch(e) {
        console.log(`Message ${msgId} not accessible: ${e.message}`);
      }
    }

    console.log(`Processing ${verifiedIds.length} verified Amazon messages`);

    for (const msgId of verifiedIds) {
      try {
        await processMessage(gmail, msgId);
      } catch(e) {
        console.error('Error processing message:', e.message);
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).end(); // Always ACK
  }
};
