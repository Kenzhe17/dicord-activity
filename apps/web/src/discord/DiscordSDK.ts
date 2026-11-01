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

    // Use authorize + authenticate flow to get user data
    console.log('Discord SDK: Authorizing...');
    const authResponse = await discordSdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });

    console.log('Discord SDK: Authorization code received');
    const code = authResponse.code;

    // Exchange code for access token on backend
    console.log('Discord SDK: Exchanging code for token...');
    const tokenResponse = await fetch('/api/auth/discord/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Discord SDK: Token exchange failed:', errorText);
      throw new Error('Failed to exchange code for token');
    }

    const { access_token } = await tokenResponse.json();
    console.log('Discord SDK: Access token received');

    // Authenticate with access token to get user data
    console.log('Discord SDK: Authenticating...');
    const auth = await discordSdk.commands.authenticate({ access_token });

    console.log('Discord SDK: User authenticated:', auth.user.id);
    return {
      access_token,
      user: {
        id: auth.user.id,
        username: auth.user.username,
        globalName: auth.user.global_name || auth.user.username,
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
      access_token: `mock_${randomId}`,
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
