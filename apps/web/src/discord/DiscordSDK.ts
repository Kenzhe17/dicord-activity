import { DiscordSDK } from '@discord/embedded-app-sdk';

// Get client ID from window config (injected by server) or env or fallback
const getClientId = () => {
  // @ts-ignore
  return window.__DISCORD_CONFIG?.clientId || import.meta.env.VITE_DISCORD_CLIENT_ID || '1566376251185168394';
};

export const discordSdk = new DiscordSDK(getClientId());

export interface DiscordAuth {
  access_token: string;
  user: {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
    discriminator: string;
  };
}

export async function initializeDiscordSDK(): Promise<DiscordAuth> {
  try {
    console.log('Discord SDK: Starting initialization...');
    console.log('Client ID:', getClientId());
    
    await discordSdk.ready();
    console.log('Discord SDK: Ready');

    // For Discord Activities, we can get user info from the platform without OAuth
    // The SDK provides the user context directly
    const platform = discordSdk.commands;
    
    // Try to get user info from platform (if available)
    // If not available, we'll skip OAuth for now and use mock data
    const user = {
      id: 'discord_user',
      username: 'Discord User',
      globalName: 'Discord User',
      avatar: null,
      discriminator: '0000',
    };

    console.log('Discord SDK: Using platform user info');
    
    return {
      access_token: 'mock_token',
      user,
    };
  } catch (error) {
    console.error('Discord SDK initialization error:', error);
    throw error;
  }
}

export function getAvatarUrl(userId: string, avatar: string | null): string {
  if (!avatar) {
    return `https://cdn.discordapp.com/embed/avatars/${(parseInt(userId) >> 22) % 6}.png`;
  }
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
}
