const fs = require('fs');
const { decodeQuotedPrintable, decodeSubject, detectEmailType, extractOrderNumber, extractOrderBlocks, applyTaxProportionally } = require('./amazon-parsing.js');

function simulateOrderEmail(path, label) {
  const raw = fs.readFileSync(path, 'utf8');
  const fromMatch = raw.match(/^From:\s*(.+)$/m);
  const subjectMatch = raw.match(/^Subject:\s*(.+)$/m);
  const dateMatch = raw.match(/^Date:\s*(.+)$/m);
  const from = fromMatch ? fromMatch[1].trim() : '';
  const subject = decodeSubject(subjectMatch ? subjectMatch[1].trim() : '');
  const orderDate = dateMatch ? new Date(dateMatch[1].trim()).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  const boundaryMatch = raw.match(/boundary="([^"]+)"/);
  let bodyText = '';
  if (boundaryMatch) {
    const parts = raw.split('--' + boundaryMatch[1]);
    parts.forEach(part => {
      if (/Content-Type:\s*text\/plain/i.test(part)) bodyText = part.replace(/^[\s\S]*?\r?\n\r?\n/, '');
    });
  }
  bodyText = decodeQuotedPrintable(bodyText);

  const emailType = detectEmailType(from, subject, bodyText);
  console.log('='.repeat(72));
  console.log(`${label}  (detected type: ${emailType}, order date: ${orderDate})`);
  console.log('='.repeat(72));

  const allOrderNumbers = [...new Set(
    [...(bodyText + ' ' + subject).matchAll(/([0-9]{3}-[0-9]{7}-[0-9]{7})/g)].map(m => m[1])
  )];
  const orderBlocks = extractOrderBlocks(bodyText);
  const subjectBase = subject.replace(/^ordered:\s*/i, '').replace(/[\u2066\u2069\u200B-\u200F\u202A-\u202E]/g, '').replace(/^\d+\s+/, '').trim();

  const allRows = [];
  for (const num of allOrderNumbers) {
    const block = orderBlocks.find(b => b.orderNumber === num && b.items.length > 0);
    let finalItems, total;
    if (block) {
      total = block.total;
      const rawItems = block.items.map(it => ({ name: it.name, listPrice: it.listPrice }));
      const itemSum = rawItems.reduce((s, it) => s + it.listPrice, 0);
      const tax = Math.max(0, parseFloat((total - itemSum).toFixed(2)));
      finalItems = applyTaxProportionally(rawItems, tax);
    } else {
      const totalPattern = /grand total[:\s]*\$?\s*([0-9,]+\.[0-9]{1,2})/gi;
      const allTotals = [...bodyText.matchAll(totalPattern)].map(m => parseFloat(m[1].replace(/,/g, '')));
      total = allTotals[allOrderNumbers.indexOf(num)] || allTotals[0] || null;
      finalItems = [{ name: subjectBase || '[Item — see order]', listPrice: total || 0, taxShare: 0, totalPrice: total || 0 }];
    }
    const rows = finalItems.map(item => [
      num, orderDate, 'order', '', item.name, item.listPrice, item.taxShare || 0, item.totalPrice || item.listPrice, '', 'pending', '',
    ]);
    allRows.push(...rows);
  }

  console.log(`\n${allRows.length} row(s) would be written to AmazonOrders:\n`);
  console.log('OrderNumber       | OrderDate  | Item                                                        | ListPrice | TaxShare | TotalPrice | Status');
  console.log('-'.repeat(160));
  allRows.forEach(r => {
    const name = r[4].length > 58 ? r[4].substring(0, 55) + '...' : r[4];
    console.log(`${r[0]} | ${r[1]} | ${name.padEnd(58)} | $${String(r[5]).padEnd(8)} | $${String(r[6]).padEnd(7)} | $${String(r[7]).padEnd(9)} | ${r[9]}`);
  });

  // Verify: does the sum of TotalPrice per order now match its Grand Total?
  const byOrder = {};
  allRows.forEach(r => { (byOrder[r[0]] = byOrder[r[0]] || []).push(parseFloat(r[7])); });
  console.log('\nOrder-total verification (this is what matchAmazonOrders compares against the real Plaid charge):');
  Object.entries(byOrder).forEach(([num, prices]) => {
    const sum = prices.reduce((a, b) => a + b, 0);
    console.log(`  ${num}: sum of TotalPrice = $${sum.toFixed(2)}`);
  });
  console.log('');
  return allRows;
}

simulateOrderEmail('/home/claude/email_samples/02_ordered.eml', 'ORDER EMAIL #1 (multi-order: Disney items + NTIERA)');
simulateOrderEmail('/home/claude/email_samples/real_01_ordered.eml', 'ORDER EMAIL #2 (Milreason dress order, 3 items)');
