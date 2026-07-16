const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'Use POST'});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({error: 'ANTHROPIC_API_KEY not configured on server'});

  const {systemPrompt, userPrompt} = req.body || {};
  if (!systemPrompt || !userPrompt) return res.status(400).json({error: 'Missing prompts'});

  try {
    const client = new Anthropic({apiKey});
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{role: 'user', content: userPrompt}],
    });
    res.status(200).json({content: message.content[0]?.text || ''});
  } catch (err) {
    console.error('Insights error:', err.message);
    res.status(500).json({error: err.message});
  }
};
