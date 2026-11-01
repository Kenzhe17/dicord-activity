import { Request, Response, NextFunction } from 'express';
import { getOrCreateUser } from '../db/postgres';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
    discriminator: string;
    balance: number;
  };
}

export async function authenticateSocket(
  token: string,
  username?: string,
  globalName?: string
): Promise<{ id: string; username: string; globalName: string | null; avatar: string | null; discriminator: string; balance: number } | null> {
  try {
    // Token is now the user_id from Discord SDK (or mock_id)
    const userId = token;

    console.log('[Auth] authenticateSocket called with token:', token);
    console.log('[Auth] username:', username);
    console.log('[Auth] globalName:', globalName);

    // Get or create user in PostgreSQL (using fixed guild_id for balance)
    const dbUser = await getOrCreateUser(userId);

    // Use provided username/globalName from Discord SDK, or generate fallback
    const isMock = userId.startsWith('mock_');
    const finalUsername = username || (isMock ? `Player${userId.replace('mock_', '')}` : 'User');
    const finalGlobalName = globalName || finalUsername;

    return {
      id: dbUser.user_id,
      username: finalUsername,
      globalName: finalGlobalName,
      avatar: null,
      discriminator: '0000',
      balance: dbUser.balance,
    };
  } catch (error) {
    console.error('Authentication failed:', error);
    return null;
  }
}
