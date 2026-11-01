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

    // Get user info from platform (no OAuth required)
    console.log('Discord SDK: Getting user info from platform...');
    const platform = await discordSdk.commands.platform();
    console.log('Discord SDK: Platform info:', platform);

    const userId = platform.user.id;
    const username = platform.user.username;
    const discriminator = platform.user.discriminator;
    const globalName = platform.user.global_name || username;
    const avatar = platform.user.avatar || null;

    console.log('Discord SDK: User ID:', userId);
    console.log('Discord SDK: Username:', username);

    return {
      access_token: userId, // Use user_id as token for identification
      user: {
        id: userId,
        username: username,
        globalName: globalName,
        avatar: avatar,
        discriminator: discriminator,
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
