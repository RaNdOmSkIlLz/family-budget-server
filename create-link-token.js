const { client } = require('./_plaidClient');

// CORS so your GitHub Pages app can call this
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: 'givens-family' },
      client_name: 'Givens Family Finances',
      products: ['transactions'],
      // Add 'investments' once you have an investments-enabled Plaid product
      country_codes: ['US'],
      language: 'en',
    });
    res.status(200).json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
};
