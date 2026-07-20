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
      return res.status(200).json({ transactions: [], message: 'No accounts connected' });
    }

    // Use client-provided date range, default to current month
    const now = new Date();
    const endDate   = req.query.end   || now.toISOString().split('T')[0];
    const startDate = req.query.start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    console.log(`Fetching transactions ${startDate} → ${endDate} (including pending)`);

    const allTransactions = [];

    for (const { institution, accessToken } of tokens) {
      try {
        const response = await client.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: {
            count: 500,
            offset: 0,
            include_personal_finance_category: true,
          },
        });

        // Include both posted AND pending transactions
        response.data.transactions.forEach(t => {
          allTransactions.push({
            transaction_id:            t.transaction_id,
            merchant_name:             t.merchant_name,
            name:                      t.name,
            amount:                    t.amount,
            date:                      t.date,
            pending:                   t.pending,           // true = not yet posted
            pending_transaction_id:    t.pending_transaction_id,
            category:                  t.category,
            personal_finance_category: t.personal_finance_category,
            institution,
          });
        });

        // Also fetch any pending transactions not yet in the date range
        // by checking the account's pending transactions directly
        if (response.data.total_transactions > 500) {
          console.log(`Warning: ${institution} has ${response.data.total_transactions} transactions, only fetched 500`);
        }

      } catch (innerErr) {
        console.error(`Transactions failed for ${institution}:`, innerErr.response?.data || innerErr.message);
      }
    }

    // Sort: pending first (most recent activity), then posted by date desc
    allTransactions.sort((a, b) => {
      if (a.pending && !b.pending) return -1;
      if (!a.pending && b.pending) return 1;
      return new Date(b.date) - new Date(a.date);
    });

    res.status(200).json({ transactions: allTransactions, startDate, endDate });
  } catch (err) {
    console.error('get-transactions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
};
