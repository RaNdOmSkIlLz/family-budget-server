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
function detectEmailType(from, subject) {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();

  if (f.includes('auto-confirm@amazon.com') || s.includes('your amazon.com order')) return 'order';
  if (f.includes('return@amazon.com') || s.includes('return') || s.includes('refund')) return 'return';
  if (s.includes('refund')) return 'refund';
  return null; // not an Amazon receipt we care about
}

// ── ORDER NUMBER EXTRACTION ───────────────────────────────────────────────────
function extractOrderNumber(text) {
  const patterns = [
    /order\s*#?\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/i,
    /order number[:\s]*([0-9]{3}-[0-9]{7}-[0-9]{7})/i,
    /([0-9]{3}-[0-9]{7}-[0-9]{7})/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── ORDER TOTAL EXTRACTION ────────────────────────────────────────────────────
function extractOrderTotal(text) {
  const patterns = [
    /order total[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
    /total[:\s]*\$([0-9,]+\.[0-9]{2})/i,
    /grand total[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

// ── ITEM EXTRACTION ───────────────────────────────────────────────────────────
function extractItems(text) {
  const items = [];

  // Pattern 1: "Item Name $XX.XX" on same or adjacent lines
  const itemPattern = /([A-Za-z][^$\n]{5,80?}?)\s+\$([0-9]+\.[0-9]{2})/g;
  let match;

  // Clean up HTML artifacts
  const cleaned = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#[0-9]+;/g, '')
    .replace(/\s+/g, ' ');

  // Try to find item/price pairs
  const lines = cleaned.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 3);

  lines.forEach((line, i) => {
    // Skip non-item lines
    if (/shipping|handling|tax|total|subtotal|discount|promotion|gift|order/i.test(line) &&
        !/^\d/.test(line)) {
      return;
    }

    // Look for price in this line
    const priceMatch = line.match(/\$([0-9]+\.[0-9]{2})/);
    if (priceMatch) {
      const price = parseFloat(priceMatch[1]);
      const name = line.replace(/\$[0-9]+\.[0-9]{2}/, '').trim().replace(/^[-•*]\s*/, '');
      if (price > 0 && price < 5000 && name.length > 3) {
        items.push({ name: name.substring(0, 100), listPrice: price });
      }
    }
  });

  return items;
}

// ── TAX EXTRACTION ────────────────────────────────────────────────────────────
function extractTax(text) {
  const patterns = [
    /estimated tax[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
    /tax[:\s]*\$([0-9,]+\.[0-9]{2})/i,
    /sales tax[:\s]*\$?([0-9,]+\.[0-9]{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return 0;
}

// ── PROPORTIONAL TAX SPLIT ────────────────────────────────────────────────────
function applyTaxProportionally(items, totalTax) {
  if (!totalTax || !items.length) return items;
  const subtotal = items.reduce((s, i) => s + i.listPrice, 0);
  return items.map(item => ({
    ...item,
    taxShare: subtotal > 0 ? parseFloat(((item.listPrice / subtotal) * totalTax).toFixed(2)) : 0,
    totalPrice: parseFloat((item.listPrice + (subtotal > 0 ? (item.listPrice / subtotal) * totalTax : 0)).toFixed(2)),
  }));
}

// ── WRITE TO AMAZON ORDERS SHEET ──────────────────────────────────────────────
async function writeOrderToSheet(orderNumber, orderDate, emailType, items, orderTotal, mismatch) {
  const rows = items.map(item => [
    orderNumber,
    orderDate,
    emailType,
    '',                    // PlaidTxnId — linked later when Plaid syncs
    item.name,
    item.listPrice,
    item.taxShare || 0,
    item.totalPrice || item.listPrice,
    '',                    // Category — filled by user in app
    'pending',             // Status
    mismatch || '',        // Mismatch delta for tracking
  ]);

  await appendRange(process.env.BUDGET_SHEET_ID, 'AmazonOrders!A:K', rows);
  console.log(`Wrote ${rows.length} items for order ${orderNumber} to AmazonOrders`);
}

// ── HANDLE RETURN EMAIL ───────────────────────────────────────────────────────
async function handleReturn(orderNumber, returnedItems, emailText) {
  try {
    const rows = await readRange('AmazonOrders!A:K');
    if (rows.length < 2) return;

    const header = rows[0];
    const data = rows.slice(1);

    // Find original order rows
    const orderRows = data.filter(r => r[0] === orderNumber && r[9] !== 'returned');

    if (!orderRows.length) {
      console.log(`No original order found for ${orderNumber} — logging return as standalone`);
      // Log return as standalone negative entries
      const returnRows = returnedItems.map(item => [
        orderNumber, new Date().toISOString().split('T')[0], 'return',
        '', item.name, -item.listPrice, -(item.taxShare||0), -(item.totalPrice||item.listPrice),
        '', 'returned', '',
      ]);
      await appendRange(process.env.BUDGET_SHEET_ID, 'AmazonOrders!A:K', returnRows);
      return;
    }

    // Match returned items to original items and mark as returned
    const updatedData = data.map(row => {
      if (row[0] !== orderNumber) return row;

      const isReturned = returnedItems.some(ri =>
        row[4] && ri.name &&
        (row[4].toLowerCase().includes(ri.name.toLowerCase().substring(0, 20)) ||
         ri.name.toLowerCase().includes(row[4].toLowerCase().substring(0, 20)))
      );

      if (isReturned) {
        const newRow = [...row];
        newRow[9] = 'returned';
        return newRow;
      }
      return row;
    });

    // Check if all items returned
    const orderItemsAfter = updatedData.filter(r => r[0] === orderNumber && r[2] === 'order');
    const allReturned = orderItemsAfter.every(r => r[9] === 'returned');
    if (allReturned) {
      updatedData.forEach(row => {
        if (row[0] === orderNumber) row[9] = 'fully_returned';
      });
    }

    // Rewrite sheet
    await clearAndWrite(process.env.BUDGET_SHEET_ID, 'AmazonOrders!A1', [header, ...updatedData]);
    console.log(`Return processed for order ${orderNumber}`);
  } catch(e) {
    console.error('Handle return error:', e.message);
  }
}

// ── MAIN WEBHOOK HANDLER ──────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Pub/Sub sends a POST with base64-encoded message
  try {
    const body = req.body || {};
    const messageData = body.message?.data;
    if (!messageData) {
      console.log('No message data in webhook');
      return res.status(200).end(); // ACK to prevent retry
    }

    // Decode Pub/Sub message
    const decoded = Buffer.from(messageData, 'base64').toString('utf8');
    const notification = JSON.parse(decoded);
    console.log('Gmail notification:', notification);

    const historyId = notification.historyId;
    if (!historyId) return res.status(200).end();

    // Fetch new emails via Gmail API
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    // Get history to find new message IDs
    const historyResponse = await gmail.users.history.list({
      userId: process.env.GMAIL_ADDRESS,
      startHistoryId: historyId,
      historyTypes: ['messageAdded'],
    });

    const history = historyResponse.data.history || [];
    const messageIds = [];
    history.forEach(h => {
      (h.messagesAdded || []).forEach(m => messageIds.push(m.message.id));
    });

    if (!messageIds.length) {
      console.log('No new messages in history');
      return res.status(200).end();
    }

    // Process each new message
    for (const msgId of messageIds) {
      try {
        const msg = await gmail.users.messages.get({
          userId: process.env.GMAIL_ADDRESS,
          id: msgId,
          format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const from    = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const date    = headers.find(h => h.name === 'Date')?.value || '';

        const emailType = detectEmailType(from, subject);
        if (!emailType) {
          console.log('Not an Amazon receipt, skipping:', subject);
          continue;
        }

        // Extract email body text
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

        const orderNumber = extractOrderNumber(bodyText + ' ' + subject);
        if (!orderNumber) {
          console.log('Could not extract order number from:', subject);
          continue;
        }

        const orderDate = new Date(date).toISOString().split('T')[0];

        if (emailType === 'order') {
          const items = extractItems(bodyText);
          const tax = extractTax(bodyText);
          const orderTotal = extractOrderTotal(bodyText);
          const itemsWithTax = applyTaxProportionally(items, tax);
          const itemsTotal = itemsWithTax.reduce((s, i) => s + (i.totalPrice || i.listPrice), 0);
          const mismatch = orderTotal ? parseFloat(Math.abs(orderTotal - itemsTotal).toFixed(2)) : null;

          if (mismatch && mismatch > 0.02) {
            console.log(`Mismatch for ${orderNumber}: order=$${orderTotal}, items=$${itemsTotal.toFixed(2)}, delta=$${mismatch}`);
          }

          if (items.length) {
            await writeOrderToSheet(orderNumber, orderDate, 'order', itemsWithTax, orderTotal, mismatch > 0.02 ? mismatch : '');
          } else {
            console.log(`No items parsed for order ${orderNumber} — writing placeholder`);
            await writeOrderToSheet(orderNumber, orderDate, 'order', [{name:'[Items not parsed - check email]', listPrice: orderTotal || 0, taxShare: 0, totalPrice: orderTotal || 0}], orderTotal, 'parse_failed');
          }

        } else if (emailType === 'return' || emailType === 'refund') {
          const returnedItems = extractItems(bodyText);
          await handleReturn(orderNumber, returnedItems, bodyText);
        }

        // Mark email as read
        await gmail.users.messages.modify({
          userId: process.env.GMAIL_ADDRESS,
          id: msgId,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });

      } catch(msgErr) {
        console.error('Error processing message:', msgErr.message);
      }
    }

    res.status(200).end(); // ACK Pub/Sub
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).end(); // Always ACK to prevent infinite retries
  }
};
