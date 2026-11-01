import axios from 'axios';
import { config } from '../config';

export interface DiscordAccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface DiscordUserResponse {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  discriminator: string;
}

export class DiscordAuthService {
  static async exchangeCodeForToken(code: string): Promise<DiscordAccessTokenResponse> {
    // For Embedded Apps, try without redirect_uri (Discord uses its own)
    const params = new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: 'authorization_code',
      code,
    });

    console.log('[OAuth] Request params:', params.toString());

    const response = await axios.post(
      'https://discord.com/api/oauth2/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    return response.data;
  }

  static async getUserInfo(accessToken: string): Promise<DiscordUserResponse> {
    const response = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data;
  }

  static getAvatarUrl(userId: string, avatar: string | null): string {
    if (!avatar) {
      return `https://cdn.discordapp.com/embed/avatars/${(parseInt(userId) >> 22) % 6}.png`;
    }
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
  }
}
