const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

// PLAID_ENV should be set to 'sandbox' or 'production' as an env var in Vercel
const env = process.env.PLAID_ENV === 'production'
  ? PlaidEnvironments.production
  : PlaidEnvironments.sandbox;

const config = new Configuration({
  basePath: env,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const client = new PlaidApi(config);

module.exports = { client };
