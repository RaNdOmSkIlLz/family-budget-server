const { google } = require('googleapis');
const { appendAtFirstEmptyRow, readRange, clearAndWrite } = require('./_sheets');
const {
  decodeQuotedPrintable,
  decodeSubject,
  detectEmailType,
  detectReturnStage,
  extractOrderNumber,
  extractOrderTotal,
  extractOrderBlocks,
  extractShipmentItems,
  extractTax,
  extractItems,
  extractReturnRequestItems,
  dedupItems,
  applyTaxProportionally,
} = require('./amazon-parsing');

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}


// ── UPDATE EXISTING ORDER IN SHEET ────────────────────────────────────────────
async function handleShipment(orderNumber, shipmentItems, orderDate) {
  console.log(`handleShipment: order=${orderNumber}, items=${shipmentItems.length}`);

  try {
    const rows = await readRange('AmazonOrders!A:L');
    if (!rows.length) return;

    const header = rows[0];
    const data = rows.slice(1);

    // Find existing rows for this order
    const existingRowIdxs = data
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r[0] === orderNumber && r[2] === 'order');

    console.log(`Found ${existingRowIdxs.length} existing rows for order ${orderNumber}`);

    if (!shipmentItems.length) {
      // No items parsed — just update status to 'shipped'
      const updated = data.map(r => {
        if (r[0] !== orderNumber || r[2] !== 'order') return r;
        const nr = [...r];
        nr[9] = 'shipped';
        return nr;
      });
      await clearAndWrite('AmazonOrders!A1', [header, ...updated]);
      return;
    }

    if (existingRowIdxs.length === 1 && existingRowIdxs[0].r[4] && 
        (existingRowIdxs[0].r[4].includes('[Item') || !existingRowIdxs[0].r[4].includes('$'))) {
      // Single generic placeholder row — replace with detailed items
      const existingRow = existingRowIdxs[0].r;
      const existingCat = existingRow[8] || ''; // preserve category if already set

      // Remove the placeholder row
      const filtered = data.filter((_, i) => i !== existingRowIdxs[0].i);

      // Add one row per shipment item
      const newRows = shipmentItems.map((item, idx) => [
        orderNumber,
        orderDate,
        'order',
        existingRow[3] || '',  // preserve PlaidTxnId
        item.name,
        item.listPrice,
        item.taxShare || 0,
        item.totalPrice,
        idx === 0 ? existingCat : '', // preserve category on first item only
        'shipped',
        existingRow[10] || '',  // preserve mismatch
        item.imageUrl || '',    // new ImageUrl column
      ]);

      await clearAndWrite('AmazonOrders!A1', [header, ...filtered, ...newRows]);
      console.log(`Replaced placeholder with ${newRows.length} detailed items for ${orderNumber}`);

    } else if (existingRowIdxs.length > 0) {
      // Already have detail rows — update names, prices, images, status
      const updated = data.map((r, ri) => {
        if (r[0] !== orderNumber || r[2] !== 'order') return r;
        const itemIdx = existingRowIdxs.findIndex(e => e.i === ri);
        if (itemIdx < 0 || !shipmentItems[itemIdx]) {
          const nr = [...r]; nr[9] = 'shipped'; return nr;
        }
        const si = shipmentItems[itemIdx];
        const nr = [...r];
        // Only update name if it's generic or shorter than shipped name
        if (!r[4] || r[4].includes('[Item') || r[4].length < si.name.length) nr[4] = si.name;
        if (si.listPrice > 0) { nr[5] = si.listPrice; nr[7] = si.totalPrice; }
        nr[9] = 'shipped';
        nr[11] = si.imageUrl || r[11] || '';
        return nr;
      });
      await clearAndWrite('AmazonOrders!A1', [header, ...updated]);
      console.log(`Updated ${existingRowIdxs.length} existing rows for ${orderNumber}`);

    } else {
      // No existing rows — insert new rows from shipment email
      console.log(`No existing order found for ${orderNumber} — inserting from shipment`);
      const newRows = shipmentItems.map(item => [
        orderNumber, orderDate, 'order', '',
        item.name, item.listPrice, 0, item.totalPrice,
        '', 'shipped', '', item.imageUrl || '',
      ]);
      for (const row of newRows) {
        await appendAtFirstEmptyRow('AmazonOrders', [row]);
      }
    }
  } catch(e) {
    console.error('handleShipment error:', e.message);
    console.error(e.stack);
  }
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
  console.log(`Writing ${rows.length} rows to AmazonOrders for order ${orderNumber}`);
  try {
    await appendAtFirstEmptyRow('AmazonOrders', rows);
    console.log(`Successfully wrote ${rows.length} items for order ${orderNumber}`);
  } catch(e) {
    console.error('writeOrderToSheet error:', e.message);
    console.error(e.stack);
  }
}

// ── HANDLE RETURN ─────────────────────────────────────────────────────────────
async function handleReturn(orderNumber, returnedItems, bodyText, subject, stage) {
  console.log(`handleReturn: orderNumber=${orderNumber}, items=${returnedItems.length}, stage=${stage}, subject="${subject}"`);
  console.log(`returnedItems:`, JSON.stringify(returnedItems.slice(0,3)));

  // Extract item from subject if no items parsed from body
  if (!returnedItems.length) {
    const subjectItem = (subject || '')
      .replace(/return request confirmed for\s*/i, '')
      .replace(/dropoff confirmed for\s*/i, '')
      .replace(/advance refund issued for\s*/i, '')
      .replace(/\.\.\.$/, '').trim();
    if (subjectItem) {
      returnedItems = [{name: subjectItem, listPrice: 0, taxShare: 0, totalPrice: 0}];
      console.log(`Using subject item: ${subjectItem}`);
    }
  }

  try {
    const rows = await readRange('AmazonOrders!A:K');
    const header = rows.length ? rows[0] : ['OrderNumber','OrderDate','EmailType','PlaidTxnId','Item','ListPrice','TaxShare','TotalPrice','Category','Status','Mismatch'];
    const data = rows.length > 1 ? rows.slice(1) : [];

    const orderRows = data.filter(r => r[0] === orderNumber && r[2] === 'order');
    console.log(`Found ${orderRows.length} matching order rows for ${orderNumber}`);

    if (orderRows.length) {
      if (stage === 'refunded') {
        // Final stage — the money is actually back. This is the ONLY point
        // that marks the item "returned", which removes it from active
        // budget matching (see matchAmazonOrders in the main app).
        const updated = data.map(row => {
          if (row[0] !== orderNumber || row[2] !== 'order') return row;
          const isReturned = returnedItems.some(ri =>
            row[4] && ri.name && (
              row[4].toLowerCase().includes(ri.name.toLowerCase().substring(0, 15)) ||
              ri.name.toLowerCase().includes(row[4].toLowerCase().substring(0, 15))
            )
          );
          if (isReturned) { const r = [...row]; r[9] = 'returned'; return r; }
          return row;
        });
        const allReturned = updated.filter(r => r[0] === orderNumber && r[2] === 'order').every(r => r[9] === 'returned');
        if (allReturned) updated.forEach(r => { if (r[0] === orderNumber) r[9] = 'fully_returned'; });
        await clearAndWrite('AmazonOrders!A1', [header, ...updated]);
        console.log(`Refund complete for ${orderNumber} — marked returned, will stop counting as active spend`);
      } else {
        // requested / dropped_off — record that a return is in progress
        // (and the known expected amount) WITHOUT touching Status, so the
        // item keeps counting as normal categorized spend until the refund
        // actually completes.
        const updated = data.map(row => {
          if (row[0] !== orderNumber || row[2] !== 'order') return row;
          if (row[9] === 'returned' || row[9] === 'fully_returned') return row; // already finalized — never regress
          const match = returnedItems.find(ri =>
            row[4] && ri.name && (
              row[4].toLowerCase().includes(ri.name.toLowerCase().substring(0, 15)) ||
              ri.name.toLowerCase().includes(row[4].toLowerCase().substring(0, 15))
            )
          );
          if (!match) return row;
          const r = [...row];
          r[10] = `return_${stage}:$${(match.totalPrice || 0).toFixed(2)}`;
          return r;
        });
        await clearAndWrite('AmazonOrders!A1', [header, ...updated]);
        console.log(`Recorded return_${stage} note for ${orderNumber} — status unchanged, still counts as spend`);
      }
    } else {
      // No matching order found — log a standalone entry. Only "refunded"
      // gets a "returned" status here; earlier stages get a distinct
      // "return_pending" status so nothing accidentally excludes them from
      // spend tracking before the refund actually completes.
      const alreadyStandalone = data.some(r =>
        r[0] === orderNumber && r[2] === 'return' && (r[10] || '').includes(`return_${stage}`)
      );
      if (alreadyStandalone) {
        console.log(`Standalone return_${stage} entry for ${orderNumber} already exists — skipping`);
      } else {
        const returnDate = new Date().toISOString().split('T')[0];
        const status = stage === 'refunded' ? 'returned' : 'return_pending';
        const returnRows = returnedItems.map(item => [
          orderNumber || 'UNKNOWN', returnDate, 'return',
          '', item.name, item.listPrice || 0, item.taxShare || 0, item.totalPrice || 0,
          '', status, `return_${stage}:no_matching_order`,
        ]);
        await appendAtFirstEmptyRow('AmazonOrders', returnRows);
        console.log(`Logged ${returnRows.length} standalone return_${stage} item(s) (no matching order found)`);
      }
    }
  } catch(e) {
    console.error('Handle return error:', e.message);
    console.error(e.stack);
  }
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
  const rawSubject = headers.find(h => h.name === 'Subject')?.value || '';
  const date    = headers.find(h => h.name === 'Date')?.value || '';

  // Decode MIME encoded-word subject (=?UTF-8?B?...?= or =?UTF-8?Q?...?=)
  const subject = decodeSubject(rawSubject);

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
  bodyText = decodeQuotedPrintable(bodyText);

  const emailType = detectEmailType(from, subject, bodyText);
  if (!emailType) { console.log('Not an Amazon receipt, skipping'); return; }

  const orderNumber = extractOrderNumber(bodyText + ' ' + subject);
  // Order confirmations genuinely need an order number to be useful — but
  // refund/return emails often don't restate the order number in the same
  // XXX-XXXXXXX-XXXXXXX format order confirmations use. Previously ANY email
  // missing that exact pattern was dropped silently here, before ever reaching
  // handleReturn()'s fallback that logs a standalone, reviewable row even
  // without a matched order — which is very likely why refunds were vanishing
  // entirely instead of showing up (even as an unmatched entry) in the sheet.
  if (!orderNumber && emailType !== 'return' && emailType !== 'refund') {
    console.log('Could not extract order number from:', subject);
    return;
  }
  if (!orderNumber) console.log('No order number found for return/refund email — will log as standalone entry:', subject);

  const orderDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  if (emailType === 'order') {
    // Find ALL order numbers in this email (Amazon sometimes combines multiple orders)
    const allOrderNumbers = [...new Set(
      [...(bodyText + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
    )];
    console.log(`Found ${allOrderNumbers.length} order number(s): ${allOrderNumbers.join(', ')}`);

    // Check which are already in sheet
    let existingOrders = new Set();
    try {
      const existing = await readRange('AmazonOrders!A:A');
      existing.slice(1).forEach(r => { if (r[0]) existingOrders.add(r[0]); });
    } catch(e) { console.error('Dedup check error:', e.message); }

    // Extract all grand totals — one per order
    // Amazon format: "Grand Total:\n$XX.XX" or "Grand Total: $XX.XX"
    const totalPattern = /grand total[:\s]*\$?\s*([0-9,]+\.[0-9]{1,2})/gi;
    const allTotals = [...bodyText.matchAll(totalPattern)].map(m => parseFloat(m[1].replace(/,/g, '')));
    console.log(`Found ${allTotals.length} total(s): ${allTotals.join(', ')}`);

    // Parse real per-order items where possible — each order's own items+total,
    // not a shared subject-line name reused across every order in the email
    // (which is wrong whenever an email combines two unrelated orders).
    const orderBlocks = extractOrderBlocks(bodyText);
    console.log(`Parsed ${orderBlocks.length} order block(s) with real items`);

    // Build subject item name(s) — used only as a fallback for any order
    // extractOrderBlocks couldn't confidently parse (unexpected formatting).
    const subjectBase = subject
      .replace(/^ordered:\s*/i, '')
      .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '')
      .replace(/^\d+\s+/, '')
      .trim();

    for (let oi = 0; oi < allOrderNumbers.length; oi++) {
      const num = allOrderNumbers[oi];

      if (existingOrders.has(num)) {
        console.log(`Order ${num} already in sheet — skipping`);
        continue;
      }

      const block = orderBlocks.find(b => b.orderNumber === num && b.items.length > 0);
      let finalItems, total;

      if (block) {
        total = block.total;
        // Distribute the gap between the Grand Total and the raw item sum as
        // tax, proportionally by item price. Without this, the sum of
        // TotalPrice never equals the real charged amount (Grand Total
        // already includes tax), which broke matchAmazonOrders' Plaid
        // transaction matching in the main app — it requires the two to
        // agree within 2 cents, and tax alone was routinely $0.50-$5+.
        const rawItems = block.items.map(it => ({ name: it.name, listPrice: it.listPrice }));
        const itemSum = rawItems.reduce((s, it) => s + it.listPrice, 0);
        const tax = Math.max(0, parseFloat((total - itemSum).toFixed(2)));
        finalItems = applyTaxProportionally(rawItems, tax);
        console.log(`Writing order ${num}: ${finalItems.length} item(s) from parsed block, items=$${itemSum.toFixed(2)} + tax=$${tax.toFixed(2)} = $${total}`);
      } else {
        // Fallback: couldn't parse this order's own items — use the old
        // subject-derived single-line approach so nothing gets dropped.
        // Only one line item here, so it already equals the full total —
        // no separate tax split needed.
        total = allTotals[oi] || allTotals[0] || null;
        const itemName = subjectBase || '[Item — see order]';
        finalItems = [{
          name: itemName,
          listPrice: total || 0,
          taxShare: 0,
          totalPrice: total || 0,
        }];
        console.log(`Writing order ${num}: "${itemName}" $${total} (fallback — no parsed block)`);
      }

      await writeOrderToSheet(num, orderDate, 'order', finalItems, total, '');
    }

    // Mark as read after all orders processed
    try {
      await gmail.users.messages.modify({
        userId: process.env.GMAIL_ADDRESS,
        id: msgId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      console.log(`Marked message ${msgId} as read`);
    } catch(e) { console.error('Mark as read error:', e.message); }

  } else if (emailType === 'delivered') {
    // Delivered notifications never restate price/item detail, so this only
    // ever touches the Status column — mirrors the safe "no items parsed"
    // path in handleShipment, just with an accurate status instead of
    // leaving delivered orders permanently stuck showing "shipped".
    try {
      const rows = await readRange('AmazonOrders!A:L');
      if (rows.length) {
        const header = rows[0];
        const data = rows.slice(1);
        const updated = data.map(r => {
          if (r[0] !== orderNumber || r[2] !== 'order') return r;
          const nr = [...r];
          nr[9] = 'delivered';
          return nr;
        });
        await clearAndWrite('AmazonOrders!A1', [header, ...updated]);
        console.log(`Marked order ${orderNumber} as delivered`);
      }
    } catch(e) { console.error('Delivered status update error:', e.message); }

    try {
      await gmail.users.messages.modify({
        userId: process.env.GMAIL_ADDRESS,
        id: msgId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      console.log(`Marked message ${msgId} as read`);
    } catch(e) { console.error('Mark as read error:', e.message); }

  } else if (emailType === 'return' || emailType === 'refund') {
    // NOTE: no blanket "already logged" dedup check here anymore — it used to
    // block ANY reprocessing once a single 'return' row existed for this
    // order, which would have silently prevented later stages (dropoff,
    // refund) from ever being recorded once the first stage (request) landed.
    // handleReturn() is idempotent per-stage on its own instead.
    const stage = detectReturnStage(subject, bodyText);
    console.log(`Return stage detected: ${stage}`);

    // Return-request emails have a specific, reliable structure — try that
    // first since it correctly scopes to just the actual returned item(s) and
    // ignores unrelated sections (refund-method summary, "products related to
    // your return" upsells) that the generic extractItems() was matching by
    // mistake. Fall back to the generic extraction for any email that doesn't
    // match this structure (e.g. a genuinely different return email format).
    const parsedReturn = extractReturnRequestItems(bodyText);
    let returnedItems;
    if (parsedReturn.items.length) {
      const perItemAmount = parsedReturn.refundTotal !== null
        ? parseFloat((parsedReturn.refundTotal / parsedReturn.items.length).toFixed(2))
        : 0;
      returnedItems = parsedReturn.items.map(it => ({
        name: it.name, listPrice: perItemAmount, taxShare: 0, totalPrice: perItemAmount,
      }));
      console.log(`Parsed ${returnedItems.length} item(s) from return-request section, refund total $${parsedReturn.refundTotal}`);
    } else {
      returnedItems = extractItems(bodyText);
    }
    await handleReturn(orderNumber || ('REFUND-' + subject.replace(/[^a-zA-Z0-9]/g, '').substring(0, 24)), returnedItems, bodyText, subject, stage);

    // Mark as read after processing
    try {
      await gmail.users.messages.modify({
        userId: process.env.GMAIL_ADDRESS,
        id: msgId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      console.log(`Marked message ${msgId} as read`);
    } catch(e) { console.error('Mark as read error:', e.message); }

  } else if (emailType === 'shipment') {
    // Extract both HTML and plain text for best parsing results
    let htmlBody = '', plainBody = '';
    const extractBoth = (part) => {
      if (part.mimeType === 'text/plain' && part.body?.data)
        plainBody += Buffer.from(part.body.data, 'base64').toString('utf8');
      if (part.mimeType === 'text/html' && part.body?.data)
        htmlBody += Buffer.from(part.body.data, 'base64').toString('utf8');
      (part.parts || []).forEach(extractBoth);
    };
    extractBoth(msg.data.payload);
    htmlBody = decodeQuotedPrintable(htmlBody);
    plainBody = decodeQuotedPrintable(plainBody);

    // Find all order numbers in this shipment email
    const allOrderNums = [...new Set(
      [...(plainBody + htmlBody + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
    )];
    console.log(`Shipment email — orders: ${allOrderNums.join(', ')}`);

    const shipmentItems = extractShipmentItems(htmlBody, plainBody);

    for (const num of allOrderNums) {
      await handleShipment(num, shipmentItems, orderDate);
    }

    // Mark as read after processing
    try {
      await gmail.users.messages.modify({
        userId: process.env.GMAIL_ADDRESS,
        id: msgId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      console.log(`Marked shipment message ${msgId} as read`);
    } catch(e) { console.error('Mark as read error:', e.message); }
  }
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

    // Always also run search as safety net — catches anything history missed.
    // IMPORTANT: scoped to is:unread. Every processed message gets marked read
    // at the end of processMessage() — without this filter, this search would
    // keep re-finding the same already-handled emails on every single webhook
    // trigger (which fires on ANY new email in the inbox, not just Amazon ones),
    // reprocessing them over and over throughout the day. That was the actual
    // cause of the sheet ending up with far more rows than real emails.
    try {
      const searchRes = await gmail.users.messages.list({
        userId: process.env.GMAIL_ADDRESS,
        q: 'is:unread (from:(auto-confirm@amazon.com OR return@amazon.com OR refund@amazon.com OR shipment-tracking@amazon.com OR ship-confirm@amazon.com OR order-update@amazon.com) OR subject:("Your Amazon.com order" OR "order confirmation" OR "Return request" OR "Shipped:" OR "Delivered:")) newer_than:1d',
        maxResults: 10,
      });
      const searchIds = (searchRes.data.messages || []).map(m => m.id);
      console.log(`Found ${searchIds.length} messages via search`);
      searchIds.forEach(id => { if (!messageIds.includes(id)) messageIds.push(id); });
    } catch(searchErr) {
      console.error('Search error:', searchErr.message);
    }

    // Also search for ANY unread email as final fallback — body check will filter
    try {
      const unreadRes = await gmail.users.messages.list({
        userId: process.env.GMAIL_ADDRESS,
        q: 'is:unread newer_than:1d',
        maxResults: 10,
      });
      const unreadIds = (unreadRes.data.messages || []).map(m => m.id);
      console.log(`Found ${unreadIds.length} unread messages`);
      unreadIds.forEach(id => { if (!messageIds.includes(id)) messageIds.push(id); });
    } catch(e) {
      console.error('Unread search error:', e.message);
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
        const rawSubj = headers.find(h => h.name === 'Subject')?.value || '';
        // Decode MIME encoded-word
        const subject = decodeSubject(rawSubj);
        console.log(`Message ${msgId}: from="${from}" subject="${subject}"`);
        // Queue for processing if it looks Amazon-related at metadata level
        // OR if it's unread (body check in processMessage will filter non-Amazon)
        const mightBeAmazon =
          detectEmailType(from, subject, '') ||
          subject.toLowerCase().includes('amazon') ||
          subject.toLowerCase().includes('fwd:') ||
          subject.toLowerCase().includes('fw:') ||
          subject.toLowerCase().includes('order') ||
          from.toLowerCase().includes('amazon');

        if (mightBeAmazon) {
          verifiedIds.push(msgId);
          console.log(`Queued for processing: ${subject}`);
        } else {
          console.log(`Skipping: ${subject}`);
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
