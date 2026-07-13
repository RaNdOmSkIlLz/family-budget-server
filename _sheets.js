const { google } = require('googleapis');

// Uses a Google Service Account so the server can read/write your Sheet
// without needing your personal OAuth token.
// Set these as Vercel env vars:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_KEY   (paste the private key, replace real newlines with \n)
//   BUDGET_SHEET_ID

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

async function getSheetsClient() {
  const auth = getAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function readRange(range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.BUDGET_SHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function writeRange(range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.BUDGET_SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function appendRange(range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.BUDGET_SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// Get the saved Plaid access token from the PlaidTokens tab
async function getStoredAccessToken() {
  const rows = await readRange('PlaidTokens!A:B');
  // Row format: [institution_name, access_token]
  // We just grab the first one for now (single-user personal app)
  if (rows.length < 2) return null;
  return rows[1][1] || null;
}

async function storeAccessToken(institutionName, accessToken) {
  // Overwrite row 2 (single token for personal use)
  await writeRange('PlaidTokens!A1', [
    ['Institution', 'AccessToken'],
    [institutionName, accessToken],
  ]);
}

async function getAllStoredTokens() {
  const rows = await readRange('PlaidTokens!A:B');
  if (rows.length < 2) return [];
  return rows.slice(1).filter(r => r[0] && r[1]).map(r => ({ institution: r[0], accessToken: r[1] }));
}

async function appendStoredToken(institutionName, accessToken) {
  await appendRange('PlaidTokens!A:B', [[institutionName, accessToken]]);
}

async function clearAndWrite(range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.BUDGET_SHEET_ID,
    range,
  });
  if (values && values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.BUDGET_SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }
}

module.exports = {
  readRange,
  writeRange,
  appendRange,
  clearAndWrite,
  getStoredAccessToken,
  storeAccessToken,
  getAllStoredTokens,
  appendStoredToken,
};
