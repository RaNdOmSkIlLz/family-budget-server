// Reusable CORS helper for all API functions
module.exports = function cors(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Return true if this was a preflight request (caller should return early)
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
};
