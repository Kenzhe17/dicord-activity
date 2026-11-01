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
  token: string
): Promise<{ id: string; username: string; globalName: string | null; avatar: string | null; discriminator: string; balance: number } | null> {
  try {
    // Token is now the user_id from Discord SDK (or mock_id)
    const userId = token;

    // Get or create user in PostgreSQL
    const dbUser = await getOrCreateUser(userId);

    // Return user info with balance
    // For mock users, generate a display name
    const isMock = userId.startsWith('mock_');
    const username = isMock ? `Player${userId.replace('mock_', '')}` : 'Discord User';
    const globalName = username;

    return {
      id: dbUser.user_id,
      username: username,
      globalName: globalName,
      avatar: null,
      discriminator: '0000',
      balance: dbUser.balance,
    };
  } catch (error) {
    console.error('Authentication failed:', error);
    return null;
  }
}
