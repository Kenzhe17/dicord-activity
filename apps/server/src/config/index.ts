export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || '',
  },
};

// Allow all origins for Discord Activity (discordsays.com domain)
// This is needed because Discord Activity uses embedded domain
export const allowedOrigins = [
  process.env.CORS_ORIGIN || '*',
  'https://*.discordsays.com',
  'https://*.discord.com',
  'https://*.discord.gg',
];
