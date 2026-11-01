import { Request, Response, NextFunction } from 'express';
import { DiscordAuthService } from '../auth/discord';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
    discriminator: string;
  };
}

export async function authenticateSocket(
  token: string
): Promise<{ id: string; username: string; globalName: string | null; avatar: string | null; discriminator: string } | null> {
  try {
    const userInfo = await DiscordAuthService.getUserInfo(token);
    return userInfo;
  } catch (error) {
    console.error('Authentication failed:', error);
    return null;
  }
}
