import { DiscordSDK } from '@discord/embedded-app-sdk';

export const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

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
    await discordSdk.ready();
    console.log('Discord SDK: Ready');

    const { code } = await discordSdk.commands.authorize({
      client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
      response_type: 'code',
      scope: ['identify', 'activities.read'],
    });
    console.log('Discord SDK: Authorization code received');

    const response = await fetch('/api/auth/discord/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Discord SDK: Token exchange failed:', error);
      throw new Error(error.error || 'Failed to exchange code for token');
    }

    const { access_token } = await response.json();
    console.log('Discord SDK: Token received');

    const auth = await discordSdk.commands.authenticate({
      access_token,
    });
    console.log('Discord SDK: Authentication successful');

    return {
      access_token,
      user: {
        id: auth.user!.id,
        username: auth.user!.username,
        globalName: auth.user!.globalName,
        avatar: auth.user!.avatar,
        discriminator: auth.user!.discriminator,
      },
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
