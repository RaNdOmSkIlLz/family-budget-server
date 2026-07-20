// Verifies a request actually came from Vercel's own cron scheduler, not the
// app or anyone else. Vercel automatically sends "Authorization: Bearer
// <CRON_SECRET>" when it invokes a scheduled cron job (see vercel.json) — this
// is a separate mechanism from the app's own APP_SECRET, and a different
// secret value, since these requests are never sent by the frontend at all.
module.exports = function requireCronSecret(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'Server not configured (CRON_SECRET missing)' });
    return false;
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
};
