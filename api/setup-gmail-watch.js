const { google } = require('googleapis');

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
  return oauth2Client;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    const response = await gmail.users.watch({
      userId: process.env.GMAIL_ADDRESS,
      requestBody: {
        topicName: process.env.PUBSUB_TOPIC,
        labelIds: ['INBOX'],
        labelFilterAction: 'include',
      },
    });

    console.log('Gmail watch set up:', response.data);
    res.status(200).json({
      success: true,
      historyId: response.data.historyId,
      expiration: new Date(parseInt(response.data.expiration)).toISOString(),
    });
  } catch (err) {
    console.error('Gmail watch error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
