const { google } = require('googleapis');
const { appendAtFirstEmptyRow, readRange, clearAndWrite } = require('./_sheets');

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

  // Direct from Amazon — check shipment first since it's more specific
  if (f.includes('shipment-tracking@amazon.com') || f.includes('ship-confirm@amazon.com')) return 'shipment';
  if (f.includes('auto-confirm@amazon.com')) return 'order';
  if (f.includes('return@amazon.com') || f.includes('refund@amazon.com')) return 'return';

  // Subject patterns
  if (s.includes('shipped:') || s.includes('your package was shipped') || s.includes('out for delivery') || s.includes('delivered')) return 'shipment';
  if (s.includes('your amazon.com order') || s.includes('amazon.com order #') || s.includes('ordered:')) return 'order';
  // This inbox only ever receives emails already filtered to Amazon senders
  // upstream (via the Gmail forwarding rule), so a subject just needs to look
  // like a refund/return — it doesn't need to also literally spell out "amazon".
  if (s.includes('return request confirmed') || s.includes('refund') || s.includes('return request') || s.includes('returned')) return 'return';

  // Body content
  const bodyHasShipment =
    b.includes('your package was shipped') ||
    b.includes('shipment-tracking@amazon.com') ||
    (b.includes('amazon') && b.includes('shipped') && b.includes('arriving'));

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
  if (bodyHasShipment) return 'shipment';
  if (bodyHasOrderConfirm) return 'order';

  return null;
}

// Decodes MIME quoted-printable encoding (=3D -> "=", soft line breaks removed).
// Gmail's API returns each message part's raw bytes but does NOT decode the
// original Content-Transfer-Encoding — HTML emails (especially forwarded ones)
// are very often quoted-printable, so without this, text is riddled with "=3D"
// artifacts and can have real content (like an order number) split mid-string
// by a soft line break, breaking any regex that expects it on one clean line.
function decodeQuotedPrintable(text) {
  if (!text) return text;
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
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

// ── SHIPMENT ITEM EXTRACTION ──────────────────────────────────────────────────
// Parses Amazon shipment emails which contain item names, prices, and image URLs
function extractShipmentItems(html, plainText) {
  const items = [];

  // Strategy 1: Parse HTML for item blocks
  // Amazon shipment emails have a pattern: image src near item name near price
  // Look for <a> tags with item names near <img> tags
  
  // Extract all image URLs (product thumbnails are typically from media-amazon.com)
  const imgPattern = /src=["'](https?:\/\/[^"']*media-amazon\.com[^"']*\.(jpg|png|gif)[^"']*?)["']/gi;
  const imgUrls = [];
  let imgMatch;
  while ((imgMatch = imgPattern.exec(html)) !== null) {
    const url = imgMatch[1];
    // Filter out logos, banners, icons — product images have specific patterns
    if (!url.includes('sprite') && !url.includes('logo') && !url.includes('pixel') &&
        !url.includes('chevron') && !url.includes('button') && !url.includes('star')) {
      imgUrls.push(url);
    }
  }

  // Extract item names from anchor text near product links
  // Amazon pattern: <a href="...amazon.com/dp/...">Item Name</a>
  const itemLinkPattern = /<a[^>]+href=["'][^"']*(?:\/dp\/|\/gp\/product\/)[^"']*["'][^>]*>([^<]{5,200})<\/a>/gi;
  const itemLinks = [];
  let linkMatch;
  while ((linkMatch = itemLinkPattern.exec(html)) !== null) {
    const name = linkMatch[1].trim()
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#[0-9]+;/g, '')
      .replace(/\s+/g, ' ');
    if (name.length > 4 && !name.match(/^(view|see|track|buy|your|amazon|order)/i)) {
      itemLinks.push(name);
    }
  }

  // Extract prices near "Quantity" text — Amazon shipment format:
  // "Glad for Kids...\nQuantity: 1\n$9.47"
  const qtyPricePattern = /quantity[:\s]*\d+[^$]*?\$([0-9]+\.[0-9]{2})/gi;
  const prices = [];
  let priceMatch;
  while ((priceMatch = qtyPricePattern.exec(plainText || html)) !== null) {
    prices.push(parseFloat(priceMatch[1]));
  }

  // Also try plain text line-by-line for item+price pairs
  if (plainText) {
    const lines = plainText.split(/[\r\n]+/).map(l => l.trim()).filter(l => l);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // Look for price pattern after a quantity line
      if (/^quantity/i.test(line)) {
        // Next non-empty line might be the price
        const nextLine = lines[li + 1] || '';
        const priceM = nextLine.match(/^\$([0-9]+\.[0-9]{2})$/);
        if (priceM && !prices.includes(parseFloat(priceM[1]))) {
          prices.push(parseFloat(priceM[1]));
        }
      }
    }
  }

  // Pair names with prices and images
  const uniqueNames = [...new Set(itemLinks)];
  uniqueNames.forEach((name, idx) => {
    items.push({
      name: name.substring(0, 150),
      listPrice: prices[idx] || 0,
      taxShare: 0,
      totalPrice: prices[idx] || 0,
      imageUrl: imgUrls[idx] || '',
    });
  });

  // Fallback: if HTML parsing got nothing, try plain text
  if (!items.length && plainText) {
    const lines = plainText.split(/[\r\n]+/).map(l => l.trim()).filter(l => l);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (/^quantity/i.test(line)) {
        // Item name is likely a few lines before quantity
        const candidateName = lines[li - 1] || '';
        const priceLine = lines[li + 1] || '';
        const priceM = priceLine.match(/^\$([0-9]+\.[0-9]{2})$/);
        if (candidateName.length > 4 && priceM) {
          items.push({
            name: candidateName.substring(0, 150),
            listPrice: parseFloat(priceM[1]),
            taxShare: 0,
            totalPrice: parseFloat(priceM[1]),
            imageUrl: imgUrls[items.length] || '',
          });
        }
      }
    }
  }

  console.log(`Shipment items parsed: ${items.length}`, items.map(i => `${i.name} $${i.listPrice}`));
  return items;
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
    await appendAtFirstEmptyRow('AmazonOrders', rows);
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
      await appendAtFirstEmptyRow('AmazonOrders', returnRows);
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
    const totalPattern = /grand total[:\s]*\$?\s*([0-9,]+\.[0-9]{2})/gi;
    const allTotals = [...bodyText.matchAll(totalPattern)].map(m => parseFloat(m[1].replace(/,/g, '')));
    console.log(`Found ${allTotals.length} total(s): ${allTotals.join(', ')}`);

    // Build subject item name(s)
    const subjectBase = subject
      .replace(/^ordered:\s*/i, '')
      .replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '')
      .replace(/^\d+\s+/, '')
      .trim();

    // Pair each order number with a total
    // If counts match — pair 1:1. If not — use first total for all or split evenly.
    for (let oi = 0; oi < allOrderNumbers.length; oi++) {
      const num = allOrderNumbers[oi];

      if (existingOrders.has(num)) {
        console.log(`Order ${num} already in sheet — skipping`);
        continue;
      }

      const total = allTotals[oi] || allTotals[0] || null;
      const itemName = subjectBase || '[Item — see order]';

      const finalItems = [{
        name: itemName,
        listPrice: total || 0,
        taxShare: 0,
        totalPrice: total || 0,
      }];

      console.log(`Writing order ${num}: "${itemName}" $${total}`);
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

  } else if (emailType === 'return' || emailType === 'refund') {
    // Refund emails that don't restate a real order number still need a stable,
    // dedupable identifier — otherwise re-processing the same email could log
    // it twice. Derive one from the subject line instead.
    const dedupKey = orderNumber || ('REFUND-' + subject.replace(/[^a-zA-Z0-9]/g, '').substring(0, 24));
    try {
      const existing = await readRange('AmazonOrders!A:C');
      const alreadyLogged = existing.slice(1).some(r => r[0] === dedupKey && r[2] === 'return');
      if (alreadyLogged) {
        console.log(`Return for ${dedupKey} already logged — skipping`);
        await gmail.users.messages.modify({
          userId: process.env.GMAIL_ADDRESS,
          id: msgId,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
        return;
      }
    } catch(e) { console.error('Return dedup check error:', e.message); }

    const returnedItems = extractItems(bodyText);
    await handleReturn(orderNumber || dedupKey, returnedItems, bodyText, subject);

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
        q: 'is:unread (from:(auto-confirm@amazon.com OR return@amazon.com OR refund@amazon.com) OR subject:("Your Amazon.com order" OR "order confirmation" OR "Return request")) newer_than:1d',
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
