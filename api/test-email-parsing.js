// Dry-run test harness for Amazon email parsing.
// Imports directly from amazon-parsing.js — the same pure parsing functions
// used by both the live webhook and the manual reprocess tool — so what you
// see here is exactly what production would do. Never touches Gmail or
// Google Sheets; no network access needed at all.
//
// Usage: node test-email-parsing.js
// (edit the test case at the bottom, or call dryRun() with your own input)

const {
  decodeQuotedPrintable,
  detectEmailType,
  extractOrderNumber,
  extractOrderBlocks,
  extractShipmentItems,
  extractItems,
  extractReturnRequestItems,
} = require('./amazon-parsing.js');

function dryRun({ from = '', subject = '', bodyText = '', htmlBody = '', plainBody = '', label = '' }) {
  const line = '='.repeat(72);
  console.log(line);
  console.log(label ? `TEST: ${label}` : 'TEST');
  console.log(line);
  console.log('From:', from || '(none provided)');
  console.log('Subject:', subject || '(none provided)');

  // For shipment emails, production decodes+combines html/plain separately.
  // For everything else, it's one combined bodyText. Support both here.
  const usingSeparateBodies = !!(htmlBody || plainBody);
  const decodedHtml = decodeQuotedPrintable(htmlBody);
  const decodedPlain = decodeQuotedPrintable(plainBody);
  const decoded = usingSeparateBodies ? (decodedPlain || decodedHtml) : decodeQuotedPrintable(bodyText);

  const rawForCompare = usingSeparateBodies ? (plainBody || htmlBody) : bodyText;
  const changed = decoded !== rawForCompare;
  console.log(`\nQuoted-printable decoding changed the text: ${changed ? 'YES' : 'no'}`);
  console.log('--- Decoded body preview (first 500 chars, whitespace collapsed) ---');
  console.log(decoded.substring(0, 500).replace(/\s+/g, ' ').trim());

  const emailType = detectEmailType(from, subject, decoded);
  console.log(`\n>>> Detected email type: ${emailType || '(NONE — this email would be SKIPPED ENTIRELY)'}`);

  if (!emailType) {
    console.log('\n(Nothing else to check — detection stopped here. This is the first thing to fix if this type should be recognized.)\n');
    return { emailType: null };
  }

  const searchText = usingSeparateBodies ? (decodedHtml + ' ' + decodedPlain) : decoded;
  const orderNumber = extractOrderNumber(searchText + ' ' + subject);
  console.log(`>>> Single order number (extractOrderNumber): ${orderNumber || '(none found)'}`);

  const allOrderNumbers = [...new Set(
    [...(searchText + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
  )];
  console.log(`>>> All order numbers found in text: ${allOrderNumbers.length ? allOrderNumbers.join(', ') : '(none)'}`);

  let result = { emailType, orderNumber, allOrderNumbers };

  if (emailType === 'order') {
    const totalPattern = /grand total[:\s]*\$?\s*([0-9,]+\.[0-9]{1,2})/gi;
    const allTotals = [...decoded.matchAll(totalPattern)].map(m => parseFloat(m[1].replace(/,/g, '')));
    console.log(`>>> Grand totals found: ${allTotals.length ? allTotals.join(', ') : '(none)'}`);
    result.totals = allTotals;

    const blocks = extractOrderBlocks(usingSeparateBodies ? decodedPlain : decoded);
    console.log(`>>> Parsed order blocks: ${blocks.length}`);
    console.log(JSON.stringify(blocks, null, 2));
    const uncovered = allOrderNumbers.filter(n => !blocks.some(b => b.orderNumber === n && b.items.length));
    if (uncovered.length) console.log(`>>> Orders needing subject-line fallback (no parsed block): ${uncovered.join(', ')}`);
    result.blocks = blocks;
  } else if (emailType === 'shipment') {
    const items = extractShipmentItems(decodedHtml || decoded, decodedPlain || decoded);
    console.log(`>>> Shipment items found: ${items.length}`);
    console.log(JSON.stringify(items, null, 2));
    result.items = items;
  } else if (emailType === 'return' || emailType === 'refund') {
    const parsedReturn = extractReturnRequestItems(decoded);
    console.log(`>>> Return-request section parse: ${parsedReturn.items.length} item(s), refund total: ${parsedReturn.refundTotal !== null ? '$' + parsedReturn.refundTotal : '(none found)'}`);
    console.log(JSON.stringify(parsedReturn, null, 2));
    result.parsedReturn = parsedReturn;

    const items = extractItems(decoded);
    console.log(`>>> Generic extractItems() fallback would find: ${items.length}`);
    console.log(JSON.stringify(items, null, 2));
    if (!items.length && !parsedReturn.items.length) {
      console.log('(No items parsed from either method — handleReturn() would fall back to using the subject line as the item name.)');
    }
    result.items = items;
  }

  console.log('\n(Dry run only — nothing was written anywhere.)\n');
  return result;
}

module.exports = { dryRun };

// ── Example / smoke test — replace with real pasted email content ──────────
if (require.main === module) {
  dryRun({
    label: 'Smoke test — QP-encoded return email (synthetic)',
    from: 'return@amazon.com',
    subject: 'Return request confirmed for HITCH REAP Women\'s Jelly Sandals...',
    bodyText: '<span class=3D"rio-text">Quantity: 1<br aria-hidden=3D"true">Order # 114-74=\r\n20597-9568238<br aria-hidden=3D"true">Reason for return: No longer neede=\r\nd</span>',
  });
}
