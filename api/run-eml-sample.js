const fs = require('fs');
const { dryRun } = require('./test-email-parsing.js');
const { decodeSubject } = require('./amazon-parsing.js');

const path = process.argv[2];
const label = process.argv[3] || path;
const raw = fs.readFileSync(path, 'utf8');

// Extract headers we care about
const fromMatch = raw.match(/^From:\s*(.+)$/m);
const subjectMatch = raw.match(/^Subject:\s*(.+)$/m);
const from = fromMatch ? fromMatch[1].trim() : '';
const subject = decodeSubject(subjectMatch ? subjectMatch[1].trim() : '');

// Split into MIME parts by boundary
const boundaryMatch = raw.match(/boundary="([^"]+)"/);
let htmlBody = '', plainBody = '';

if (boundaryMatch) {
  const boundary = boundaryMatch[1];
  const parts = raw.split('--' + boundary);
  parts.forEach(part => {
    if (/Content-Type:\s*text\/plain/i.test(part)) {
      plainBody = part.replace(/^[\s\S]*?\r?\n\r?\n/, ''); // strip part headers (handles CRLF)
    } else if (/Content-Type:\s*text\/html/i.test(part)) {
      htmlBody = part.replace(/^[\s\S]*?\r?\n\r?\n/, '');
    }
  });
} else {
  // No multipart boundary — treat everything after the header block as the body
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const match = raw.match(/\r?\n\r?\n/);
  plainBody = headerEnd >= 0 ? raw.slice(headerEnd + match[0].length) : raw;
}

dryRun({ from, subject, htmlBody, plainBody, label });
