const { client } = require('./_plaidClient');
const { appendStoredToken } = require('./_sheets');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const { public_token, institution_name } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  try {
    const exchange = await client.itemPublicTokenExchange({ public_token });
    const accessToken = exchange.data.access_token;
    await appendStoredToken(institution_name || 'Unknown institution', accessToken);
    res.status(200).json({ success: true, institution: institution_name });
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
};
