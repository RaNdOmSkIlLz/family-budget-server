const { client } = require('./_plaidClient');
const { getAllStoredTokens } = require('./_sheets');
const requireAppSecret = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAppSecret(req, res)) return;

  try {
    const tokens = await getAllStoredTokens();
    if (!tokens.length) {
      return res.status(200).json({ accounts: [], message: 'No accounts connected yet' });
    }

    const allAccounts = [];
    for (const { institution, accessToken } of tokens) {
      try {
        const balResponse = await client.accountsBalanceGet({ access_token: accessToken });
        balResponse.data.accounts.forEach(acct => {
          allAccounts.push({
            institution,
            accountId: acct.account_id,
            mask: acct.mask,
            name: acct.name,
            officialName: acct.official_name,
            type: acct.type,
            subtype: acct.subtype,
            balance: acct.balances.current,
            available: acct.balances.available,
            currency: acct.balances.iso_currency_code,
          });
        });
      } catch (innerErr) {
        console.error(`Balance fetch failed for ${institution}:`, innerErr.response?.data || innerErr.message);
        allAccounts.push({ institution, error: 'Failed to fetch — token may need refresh' });
      }
    }
    res.status(200).json({ accounts: allAccounts });
  } catch (err) {
    console.error('get-balances error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
};
