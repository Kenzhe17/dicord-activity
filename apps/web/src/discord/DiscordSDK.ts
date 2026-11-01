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
    
    // In Discord Embedded Apps, authenticate() should be called without parameters
    // to let Discord handle the OAuth flow automatically
    const auth = await discordSdk.commands.authenticate();
    
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
    throw error;
  }
}

export function getAvatarUrl(userId: string, avatar: string | null): string {
  if (!avatar) {
    return `https://cdn.discordapp.com/embed/avatars/${(parseInt(userId) >> 22) % 6}.png`;
  }
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
}
