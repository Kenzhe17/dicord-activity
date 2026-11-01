export const config = {
  port: process.env.PORT || 3001,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || '',
  },
};
