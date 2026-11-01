import { DiscordSDK } from '@discord/embedded-app-sdk';

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
    console.log('Discord SDK: Initializing...');

    const clientId = __DISCORD_CLIENT_ID__;
    console.log('Discord SDK: Client ID:', clientId);

    const discordSdk = new DiscordSDK(clientId);

    console.log('Discord SDK: Waiting for ready...');
    await discordSdk.ready();
    console.log('Discord SDK: Ready');

    // Step 1: Authorize with Discord to get OAuth code
    console.log('Discord SDK: Authorizing...');
    const { code } = await discordSdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    console.log('Discord SDK: Authorization code received');

    // Step 2: Exchange code for access token via backend
    console.log('Discord SDK: Exchanging code for token...');
    const response = await fetch('/api/auth/discord/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      throw new Error('Failed to exchange code for token');
    }

    const { access_token } = await response.json();
    console.log('Discord SDK: Access token received');

    // Step 3: Authenticate with Discord client using the access token
    console.log('Discord SDK: Authenticating...');
    const auth = await discordSdk.commands.authenticate({
      access_token,
    });

    console.log('Discord SDK: Authenticated', auth);

    return {
      access_token: auth.access_token,
      user: {
        id: auth.user.id,
        username: auth.user.username,
        globalName: auth.user.global_name || null,
        avatar: auth.user.avatar || null,
        discriminator: auth.user.discriminator,
      },
    };
  } catch (error) {
    console.error('Discord SDK initialization error:', error);
    console.log('Discord SDK: Falling back to mock user for testing');

    // Fallback to mock user for testing/development
    const randomId = Math.floor(Math.random() * 1000000).toString();
    return {
      access_token: 'mock_token',
      user: {
        id: `mock_${randomId}`,
        username: `Player${randomId}`,
        globalName: `Player${randomId}`,
        avatar: null,
        discriminator: '0000',
      },
    };
  }
}

export function getAvatarUrl(userId: string, avatar: string | null): string {
  if (!avatar) {
    return `https://cdn.discordapp.com/embed/avatars/${(parseInt(userId) >> 22) % 6}.png`;
  }
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
}
