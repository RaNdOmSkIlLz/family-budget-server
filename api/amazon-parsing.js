// ── amazon-parsing.js ───────────────────────────────────────────────────────
// Pure, dependency-free Amazon email parsing logic. No Gmail API, no Sheets
// API, no network calls of any kind — just string/regex parsing functions
// that take email text in and return structured data out.
//
// This is the SINGLE SOURCE OF TRUTH for parsing logic. Both amazon-webhook.js
// (the live webhook) and reprocess-amazon.js (the manual recovery tool) import
// directly from here instead of keeping their own separate copies — which is
// exactly what caused bugs to get fixed in one place and silently persist in
// the other. test-email-parsing.js also imports from here, so dry-run tests
// are guaranteed to reflect real production behavior.

// ── EMAIL TYPE DETECTION ──────────────────────────────────────────────────────
// Distinguishes which stage of the return lifecycle a 'return' email
// represents. This matters because the three stages should NOT all trigger
// the same "returned" status — only the final one (refunded) means the money
// is actually back and the item should stop counting as active spend.
function detectReturnStage(subject, bodyText) {
  const s = (subject || '').toLowerCase();
  const b = (bodyText || '').toLowerCase().substring(0, 3000);
  if (s.includes('advance refund') || s.includes('refund issued') || s.includes('refund was issued') || b.includes('your refund was issued')) return 'refunded';
  if (s.includes('dropoff confirmed') || s.includes('drop off') || b.includes('dropoff confirmed') || b.includes('your return is in-transit')) return 'dropped_off';
  if (s.includes('return request confirmed') || s.includes('return request') || b.includes('your return request is confirmed')) return 'requested';
  return 'requested'; // safest default — never skip budget impact prematurely
}

function detectEmailType(from, subject, bodyText) {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  const b = (bodyText || '').toLowerCase().substring(0, 5000);

  // Direct from Amazon — check shipment first since it's more specific
  if (f.includes('shipment-tracking@amazon.com') || f.includes('ship-confirm@amazon.com')) return 'shipment';
  if (f.includes('auto-confirm@amazon.com')) return 'order';
  if (f.includes('return@amazon.com') || f.includes('refund@amazon.com')) return 'return';

  // Subject patterns
  if (s.startsWith('delivered:') || s.includes('package was delivered') || s.includes('was delivered')) return 'delivered';
  if (s.includes('shipped:') || s.includes('your package was shipped') || s.includes('out for delivery')) return 'shipment';
  if (s.includes('your amazon.com order') || s.includes('amazon.com order #') || s.includes('ordered:')) return 'order';
  // This inbox only ever receives emails already filtered to Amazon senders
  // upstream (via the Gmail forwarding rule), so a subject just needs to look
  // like a refund/return — it doesn't need to also literally spell out "amazon".
  if (s.includes('return request confirmed') || s.includes('refund') || s.includes('return request') || s.includes('returned') || s.includes('dropoff confirmed') || s.includes('drop off') || s.includes('advance refund')) return 'return';

  // Body content
  const bodyHasDelivered = b.includes('your package was delivered') || b.includes('delivered today');
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
  if (bodyHasDelivered) return 'delivered';
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
    /order total[:\s]*\$?([0-9,]+\.[0-9]{1,2})/i,
    /grand total[:\s]*\$?([0-9,]+\.[0-9]{1,2})/i,
    /total[:\s]*\$([0-9,]+\.[0-9]{1,2})/i,
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
  
  // Extract product thumbnail URLs specifically. Amazon serves actual product
  // photos from an /images/I/ path and decorative UI icons (checkmarks, step
  // trackers, banners, etc.) from /images/G/ — matching on /images/I/ directly
  // is far more reliable than trying to denylist every decorative filename,
  // which previously let things like the "shipped" checkmark icon slip through
  // as if it were a product photo.
  const imgPattern = /src=["'](https?:\/\/[^"']*media-amazon\.com\/images\/I\/[^"']*\.(jpg|png|gif)[^"']*?)["']/gi;
  const imgUrls = [];
  let imgMatch;
  while ((imgMatch = imgPattern.exec(html)) !== null) {
    imgUrls.push(imgMatch[1]);
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

  // Extract prices near "Quantity" text — Amazon shipment format is actually
  // "Quantity: 1\n9.99 USD" (no dollar sign at all) or sometimes "$9.99" —
  // accept both.
  const qtyPricePattern = /quantity[:\s]*\d+[\s\S]{0,80}?\$?([0-9]+\.[0-9]{1,2})\s*(?:USD)?/gi;
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
        const priceM = nextLine.match(/^\$?([0-9]+\.[0-9]{1,2})\s*(?:USD)?$/i);
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
        // Item name is likely a few lines before quantity. Amazon's plain-text
        // format prefixes each item with a literal "* " bullet — strip it,
        // otherwise it ends up baked into the stored item name.
        const candidateName = (lines[li - 1] || '').replace(/^\*\s*/, '');
        const priceLine = lines[li + 1] || '';
        const priceM = priceLine.match(/^\$?([0-9]+\.[0-9]{1,2})\s*(?:USD)?$/i);
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

function extractTax(text) {
  const patterns = [
    /estimated tax[:\s]*\$?([0-9,]+\.[0-9]{1,2})/i,
    /sales tax[:\s]*\$?([0-9,]+\.[0-9]{1,2})/i,
    /tax[:\s]*\$([0-9,]+\.[0-9]{1,2})/i,
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
  const qtyItemPrice = /(\d+)\s+(.{3,80}?)\s+\$([0-9]+\.[0-9]{1,2})/gm;
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
  const priceMatches = [...text.matchAll(/\$([0-9]+\.[0-9]{1,2})/g)];
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
    const priceNext = nextLine.match(/^\$([0-9]+\.[0-9]{1,2})$/);
    const priceInline = line.match(/\$([0-9]+\.[0-9]{1,2})$/);

    if (priceNext && line.length > 4 && line.length < 150) {
      items.push({name: line.substring(0, 100), listPrice: parseFloat(priceNext[1])});
      li++; // skip price line
    } else if (priceInline) {
      const name = line.replace(/\$[0-9]+\.[0-9]{1,2}$/, '').trim();
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


// Decodes MIME encoded-word email subjects (e.g. "=?UTF-8?B?...?=" or
// "=?UTF-8?Q?...?="), which forwarded/non-ASCII subjects commonly use.
function decodeSubject(raw) {
  if (!raw) return raw;
  return raw.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, encoded) => {
    try {
      return enc.toUpperCase() === 'B'
        ? Buffer.from(encoded, 'base64').toString('utf8')
        : encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16)));
    } catch(e) { return raw; }
  });
}

// Parses a multi-order confirmation email into one entry per actual order,
// each with its own items and total — instead of the old approach of pairing
// order numbers with totals by array position and reusing one subject-derived
// name for every order in the email (wrong whenever an email combines two
// unrelated orders, which Amazon does regularly).
//
// Each order's items+total all sit between its "Order #" line and the next
// "Grand Total:" line, even when Amazon restates the same order number once
// per item within that order.
function extractOrderBlocks(text) {
  const blocks = [];
  const blockRegex = /Order\s*#\s*\n?\s*([0-9]{3}-[0-9]{7}-[0-9]{7})([\s\S]*?)Grand Total:?\s*\n?\s*\$?([0-9,]+\.[0-9]{1,2})/gi;
  let m;
  while ((m = blockRegex.exec(text)) !== null) {
    const orderNumber = m[1];
    const blockBody = m[2];
    const total = parseFloat(m[3].replace(/,/g, ''));
    const items = [];
    const itemRegex = /\*\s*([\s\S]*?)\n\s*Quantity:\s*\d+\s*\n\s*\$?([0-9]+\.[0-9]{1,2})\s*(?:USD)?/gi;
    let im;
    while ((im = itemRegex.exec(blockBody)) !== null) {
      items.push({
        name: im[1].replace(/\s+/g, ' ').trim().substring(0, 150),
        listPrice: parseFloat(im[2]),
      });
    }
    // A block that matched "Order #...Grand Total" but found no item lines
    // inside (unexpected formatting) still keeps its total — downstream
    // code falls back to a subject-derived name in that case.
    blocks.push({ orderNumber, items, total });
  }
  return blocks;
}

// Return-request confirmation emails have a specific, reliable structure that
// the generic extractItems() gets wrong on — it was picking up "Refund method"
// (a section heading, not a product) and items from the unrelated "Products
// related to your return" upsell section further down the email. This scopes
// strictly to the "Item(s) in your return request" section, where Amazon
// renders the actual returned item as a "[Name](link)\nQuantity: N" pair, and
// separately grabs the real refund total from its own explicit line.
function extractReturnRequestItems(text) {
  const items = [];
  const sectionMatch = text.match(/Item\(s\) in your return request[\s\S]*?(?=Cancel return|Return code|Refund subtotal|\$)/i);
  const section = sectionMatch ? sectionMatch[0] : text;
  const itemPattern = /\[([^\]]{5,200})\]\([^)]*\)\s*\r?\n\s*Quantity:\s*(\d+)/gi;
  let m;
  while ((m = itemPattern.exec(section)) !== null) {
    items.push({ name: m[1].trim(), quantity: parseInt(m[2], 10) });
  }
  const totalMatch = text.match(/Total estimated refund\*?\s*\$?([0-9,]+\.[0-9]{1,2})/i) ||
                      text.match(/Refund subtotal\s*\$?([0-9,]+\.[0-9]{1,2})/i);
  const refundTotal = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : null;
  return { items, refundTotal };
}

module.exports = {
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
};
