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
  const b = (bodyText || '').toLowerCase().substring(0, 5000);

  // Direct from Amazon
  if (f.includes('auto-confirm@amazon.com')) return 'order';
  if (f.includes('return@amazon.com') || f.includes('refund@amazon.com')) return 'return';

  // Subject patterns (covers forwarded emails where subject is preserved)
  if (s.includes('your amazon.com order') || s.includes('amazon.com order #')) return 'order';
  if (s.includes('return request confirmed') || s.includes('refund') && s.includes('amazon')) return 'return';

  // Body content — check for Amazon order confirmation markers
  const bodyHasOrderConfirm =
    b.includes('auto-confirm@amazon.com') ||
    b.includes('order confirmation') ||
    b.includes('your amazon.com order') ||
    b.includes('amazon.com/gp/css/order') ||
    b.includes('amazon.com/your-orders') ||
    (b.includes('amazon') && b.includes('order total') && b.includes('items ordered'));

  const bodyHasReturn =
    b.includes('return request') ||
    (b.includes('amazon') && b.includes('refund'));

  if (bodyHasReturn) return 'return';
  if (bodyHasOrderConfirm) return 'order';

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

  // ── Strategy 1: Plain text section (most reliable) ──
  // Amazon plain text format:
  //   "⁦1⁩ Tires item"  or  "Item Name\n$XX.XX"
  // Strip quoted-printable encoding artifacts first
  const plain = text
    .replace(/=\r?\n/g, '')          // QP soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '') // Unicode directional chars
    .replace(/&zwnj;|&nbsp;|&#[0-9]+;|&[a-z]+;/gi, ' ');

  // Strategy 1a: Look for "Qty Item Name $Price" patterns in plain text
  const qtyItemPrice = /(\d+)\s+(.{3,80}?)\s+\$([0-9]+\.[0-9]{2})/gm;
  let m;
  while ((m = qtyItemPrice.exec(plain)) !== null) {
    const qty = parseInt(m[1]);
    const name = m[2].trim();
    const price = parseFloat(m[3]);
    if (price > 0 && price < 5000 && name.length > 2 && !name.match(/total|shipping|tax|order|subtotal/i)) {
      for (let q = 0; q < Math.min(qty, 10); q++) {
        items.push({name: name.substring(0, 100), listPrice: price});
      }
    }
  }

  if (items.length) return dedupItems(items);

  // Strategy 1b: Look for HTML product cells — Amazon uses specific class names
  // Pattern: productImage alt="item name" near a price
  const productImageAlt = /alt=["']([^"']{5,100})["'][^>]*class=["'][^"']*productImage/gi;
  const productPrices = [];

  // Extract all prices from the HTML
  const priceMatches = [...text.matchAll(/\$([0-9]+\.[0-9]{2})/g)];
  priceMatches.forEach(pm => {
    const p = parseFloat(pm[1]);
    if (p > 0.50 && p < 2000) productPrices.push(p);
  });

  // Extract item names from product image alt text
  const imgNames = [];
  let imgM;
  while ((imgM = productImageAlt.exec(text)) !== null) {
    const name = imgM[1].trim();
    if (name && !name.match(/Completed|Pending|Amazon|logo|banner/i)) {
      imgNames.push(name);
    }
  }

  // Also look for span content near "rio-text" classes that has item descriptions
  // Pattern: <span class="rio-text ...">item name</span>
  const rioTextSpan = /<span[^>]+class=["'][^"']*rio-text[^"']*["'][^>]*>([^<]{5,100})<\/span>/gi;
  let rtM;
  while ((rtM = rioTextSpan.exec(text)) !== null) {
    const content = rtM[1].trim()
      .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '')
      .replace(/^[\d\s⁦⁩]+/, '') // strip leading qty chars
      .trim();
    // Filter out navigation/shipping status text
    if (content.length > 4 && content.length < 150 &&
        !content.match(/^(Ordered|Shipped|Delivered|Out for|Arriving|Your Orders|Your Account|Buy Again|Thanks|Order #|Mattie|Grand Total|View or|Privacy|Conditions|Amazon\.com)/i)) {
      imgNames.push(content);
    }
  }

  // De-dup names
  const uniqueNames = [...new Set(imgNames)].filter(n => n.length > 3);

  if (uniqueNames.length > 0) {
    // If we have prices matching the count, pair them
    uniqueNames.forEach((name, idx) => {
      const price = productPrices[idx] || 0;
      items.push({name: name.substring(0, 100), listPrice: price});
    });
    if (items.length) return dedupItems(items);
  }

  // Strategy 2: Plain text line-by-line scan for item + price pairs
  const lines = plain.split(/[\r\n]+/).map(l => l.trim()).filter(l => l);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // Skip obvious non-item lines
    if (/^(grand total|order total|subtotal|shipping|tax|estimated|your orders|your account|buy again|thanks|arriving|ordered|shipped|delivered|out for|view or|privacy|conditions|amazon\.com|©|\$0\.00)/i.test(line)) continue;
    // Look for standalone price on next line after an item name
    const nextLine = lines[li + 1] || '';
    const priceNext = nextLine.match(/^\$([0-9]+\.[0-9]{2})$/);
    const priceInline = line.match(/\$([0-9]+\.[0-9]{2})$/);

    if (priceNext && line.length > 4 && line.length < 150) {
      items.push({name: line.substring(0, 100), listPrice: parseFloat(priceNext[1])});
      li++; // skip price line
    } else if (priceInline) {
      const name = line.replace(/\$[0-9]+\.[0-9]{2}$/, '').trim();
      if (name.length > 4 && !name.match(/total|shipping|tax|order/i)) {
        items.push({name: name.substring(0, 100), listPrice: parseFloat(priceInline[1])});
      }
    }
  }

  return dedupItems(items);
}

function dedupItems(items) {
  const seen = new Set();
  return items.filter(i => {
    const key = i.name.substring(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  console.log(`Writing ${rows.length} rows to AmazonOrders for order ${orderNumber}`);
  try {
    await appendRange('AmazonOrders!A:K', rows);
    console.log(`Successfully wrote ${rows.length} items for order ${orderNumber}`);
  } catch(e) {
    console.error('writeOrderToSheet error:', e.message);
    console.error(e.stack);
  }
}

// ── HANDLE RETURN ─────────────────────────────────────────────────────────────
async function handleReturn(orderNumber, returnedItems, bodyText, subject) {
  console.log(`handleReturn: orderNumber=${orderNumber}, items=${returnedItems.length}, subject="${subject}"`);
  console.log(`returnedItems:`, JSON.stringify(returnedItems.slice(0,3)));

  // Extract item from subject if no items parsed from body
  // Subject: "Return request confirmed for ITEM NAME..."
  if (!returnedItems.length) {
    const subjectItem = (subject || '').replace(/return request confirmed for\s*/i, '').replace(/\.\.\.$/, '').trim();
    if (subjectItem) {
      returnedItems = [{name: subjectItem, listPrice: 0, taxShare: 0, totalPrice: 0}];
      console.log(`Using subject item: ${subjectItem}`);
    }
  }

  try {
    const rows = await readRange('AmazonOrders!A:K');
    const header = rows.length ? rows[0] : ['OrderNumber','OrderDate','EmailType','PlaidTxnId','Item','ListPrice','TaxShare','TotalPrice','Category','Status','Mismatch'];
    const data = rows.length > 1 ? rows.slice(1) : [];

    // Try to find and update matching original order
    const orderRows = data.filter(r => r[0] === orderNumber && r[2] === 'order');
    console.log(`Found ${orderRows.length} matching order rows for ${orderNumber}`);

    if (orderRows.length) {
      // Mark matching items as returned
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
      console.log(`Updated existing order ${orderNumber} with return status`);
    } else {
      // No matching order found — log the return as a standalone entry
      const returnDate = new Date().toISOString().split('T')[0];
      const returnRows = returnedItems.map(item => [
        orderNumber || 'UNKNOWN', returnDate, 'return',
        '', item.name, item.listPrice || 0, item.taxShare || 0, item.totalPrice || 0,
        '', 'returned', 'no_matching_order',
      ]);
      await appendRange('AmazonOrders!A:K', returnRows);
      console.log(`Logged ${returnRows.length} return items (no matching order found)`);
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
  const subject = rawSubject.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(encoded, 'base64').toString('utf8');
      } else {
        return encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16)));
      }
    } catch(e) { return rawSubject; }
  });

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

  // Mark as read IMMEDIATELY to prevent reprocessing on next webhook fire
  try {
    await gmail.users.messages.modify({
      userId: process.env.GMAIL_ADDRESS,
      id: msgId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
    console.log(`Marked message ${msgId} as read`);
  } catch(e) {
    console.error('Mark as read error:', e.message);
  }

  if (emailType === 'order') {
    // Check for duplicate order number before writing
    try {
      const existing = await readRange('AmazonOrders!A:A');
      const existingOrders = existing.slice(1).map(r => r[0]);
      if (orderNumber && existingOrders.includes(orderNumber)) {
        console.log(`Order ${orderNumber} already in sheet — skipping`);
        return;
      }
    } catch(e) { console.error('Dedup check error:', e.message); }

    const items = extractItems(bodyText);
    const tax = extractTax(bodyText);
    const orderTotal = extractOrderTotal(bodyText);

    // Extract item description from subject or body for single-item fallback
    // Amazon subject format: "Ordered: ⁦1⁩ Tires item" → "Tires item"
    const subjectItem = subject
      .replace(/^ordered:\s*/i, '')
      .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '')
      .replace(/^\d+\s+/, '') // strip leading quantity
      .trim();

    const itemsWithTax = applyTaxProportionally(items, tax);
    const itemsTotal = parseFloat(itemsWithTax.reduce((s, i) => s + (i.totalPrice || i.listPrice), 0).toFixed(2));
    const mismatch = orderTotal && Math.abs(orderTotal - itemsTotal) > 0.02
      ? parseFloat(Math.abs(orderTotal - itemsTotal).toFixed(2))
      : null;

    if (mismatch) console.log(`Mismatch for ${orderNumber}: order=$${orderTotal}, items=$${itemsTotal}, delta=$${mismatch}`);

    let finalItems;
    if (items.length && !mismatch) {
      finalItems = itemsWithTax;
    } else {
      // No line-item prices in this email type (common for Amazon "Ordered" emails)
      // Write a single item using the subject description and full order total
      const itemName = subjectItem.length > 3 ? subjectItem : '[Item — see order]';
      finalItems = [{
        name: itemName,
        listPrice: orderTotal || 0,
        taxShare: 0,
        totalPrice: orderTotal || 0,
      }];
      console.log(`No item prices parsed — using single item: "${itemName}" $${orderTotal}`);
    }

    await writeOrderToSheet(orderNumber, orderDate, 'order', finalItems, orderTotal, mismatch || '');

  } else if (emailType === 'return' || emailType === 'refund') {
    // Check for duplicate return before writing
    try {
      const existing = await readRange('AmazonOrders!A:C');
      const alreadyLogged = existing.slice(1).some(r => r[0] === orderNumber && r[2] === 'return');
      if (alreadyLogged) {
        console.log(`Return for ${orderNumber} already logged — skipping`);
        return;
      }
    } catch(e) { console.error('Return dedup check error:', e.message); }

    const returnedItems = extractItems(bodyText);
    await handleReturn(orderNumber, returnedItems, bodyText, subject);
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

    // Always also run search as safety net — catches anything history missed
    // Search broadly for any Amazon-related email, not just direct from Amazon
    // since forwarded emails come from the user's main Gmail address
    try {
      const searchRes = await gmail.users.messages.list({
        userId: process.env.GMAIL_ADDRESS,
        q: '(from:(auto-confirm@amazon.com OR return@amazon.com OR refund@amazon.com) OR subject:("Your Amazon.com order" OR "order confirmation" OR "Return request")) newer_than:1d',
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
        const subject = rawSubj.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, encoded) => {
          try {
            return enc.toUpperCase() === 'B'
              ? Buffer.from(encoded, 'base64').toString('utf8')
              : encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16)));
          } catch(e) { return rawSubj; }
        });
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
