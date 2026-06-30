const { client } = require('./_plaidClient');
const { getAllStoredTokens } = require('./_sheets');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tokens = await getAllStoredTokens();
    if (!tokens.length) {
      return res.status(200).json({ transactions: [], message: 'No accounts connected' });
    }

    // Get current month date range
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().split('T')[0];
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString().split('T')[0];

    const allTransactions = [];

    for (const { institution, accessToken } of tokens) {
      try {
        const response = await client.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset: 0 },
        });
        response.data.transactions.forEach(t => {
          allTransactions.push({
            transaction_id: t.transaction_id,
            merchant_name: t.merchant_name,
            name: t.name,
            amount: t.amount, // positive = debit (money out)
            date: t.date,
            category: t.category,
            personal_finance_category: t.personal_finance_category,
            institution,
          });
        });
      } catch (innerErr) {
        console.error(`Transactions failed for ${institution}:`, innerErr.response?.data || innerErr.message);
      }
    }

    // Sort by date descending
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json({ transactions: allTransactions, startDate, endDate });
  } catch (err) {
    console.error('get-transactions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
};
