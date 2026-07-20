// Called weekly by Vercel cron to renew the Gmail watch (expires every 7 days)
const { google } = require('googleapis');
const requireCronSecret = require('./_cronAuth');

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronSecret(req, res)) return;

  try {
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    // Stop existing watch first
    try {
      await gmail.users.stop({ userId: process.env.GMAIL_ADDRESS });
    } catch(e) { console.log('No existing watch to stop'); }

    // Start new watch
    const response = await gmail.users.watch({
      userId: process.env.GMAIL_ADDRESS,
      requestBody: {
        topicName: process.env.PUBSUB_TOPIC,
        labelIds: ['INBOX'],
        labelFilterAction: 'include',
      },
    });

    console.log('Gmail watch renewed, expires:', new Date(parseInt(response.data.expiration)).toISOString());
    res.status(200).json({ success: true, expiration: new Date(parseInt(response.data.expiration)).toISOString() });
  } catch (err) {
    console.error('Renew watch error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
