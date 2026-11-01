import { Pool, PoolClient } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export interface User {
  user_id: string; // Discord user_id (string), converted to number for DB bigint column
  balance: number;
}

export async function getUser(userId: string, fixedGuildId?: string): Promise<User | null> {
  try {
    console.log('[DB] getUser called with userId:', userId);
    console.log('[DB] userId type:', typeof userId);
    console.log('[DB] fixedGuildId:', fixedGuildId);

    // Use BigInt to preserve full 64-bit precision for Discord snowflake IDs
    const userIdBigInt = BigInt(userId);
    console.log('[DB] Parsed userIdBigInt:', userIdBigInt.toString());

    // Query with both user_id and guild_id if provided
    let query = 'SELECT user_id, balance FROM user_balance WHERE user_id = $1';
    const params: any[] = [userIdBigInt];

    if (fixedGuildId) {
      query += ' AND guild_id = $2';
      params.push(BigInt(fixedGuildId));
    }

    const result = await pool.query(query, params);
    if (result.rows[0]) {
      // Convert number back to string for consistency
      return {
        user_id: userId,
        balance: result.rows[0].balance,
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching user:', error);
    return null;
  }
}

export async function createUser(userId: string, initialBalance: number = 0, guildId?: string): Promise<User> {
  try {
    // Use BigInt to preserve full 64-bit precision for Discord snowflake IDs
    const userIdBigInt = BigInt(userId);
    const guildIdBigInt = guildId ? BigInt(guildId) : null;

    const result = await pool.query(
      'INSERT INTO user_balance (user_id, balance, guild_id) VALUES ($1, $2, $3) RETURNING user_id, balance',
      [userIdBigInt, initialBalance, guildIdBigInt]
    );
    // Convert number back to string for consistency
    return {
      user_id: userId,
      balance: result.rows[0].balance,
    };
  } catch (error) {
    console.error('Error creating user:', error);
    throw error;
  }
}

export async function getOrCreateUser(userId: string, guildId?: string): Promise<User> {
  // For mock users (testing), don't use database
  if (userId.startsWith('mock_')) {
    console.log(`[DB] Using mock user (no DB access): ${userId}`);
    return {
      user_id: userId,
      balance: 0,
    };
  }

  // Use fixed guild_id for balance lookup (1196165488565289012)
  const fixedGuildId = '1196165488565289012';
  let user = await getUser(userId, fixedGuildId);
  if (!user) {
    console.log(`[DB] Creating new user in user_balance table: ${userId}, guildId: ${fixedGuildId}`);
    user = await createUser(userId, 0, fixedGuildId);
  }
  return user;
}

export async function updateBalance(userId: string, amount: number): Promise<User> {
  // For mock users (testing), don't use database
  if (userId.startsWith('mock_')) {
    console.log(`[DB] Mock user balance update (no DB access): ${userId}, amount: ${amount}`);
    return {
      user_id: userId,
      balance: 0, // Mock users always have 0 balance
    };
  }

  try {
    // Use BigInt to preserve full 64-bit precision for Discord snowflake IDs
    const userIdBigInt = BigInt(userId);
    const result = await pool.query(
      'UPDATE user_balance SET balance = balance + $1 WHERE user_id = $2 RETURNING user_id, balance',
      [amount, userIdBigInt]
    );
    // Convert number back to string for consistency
    return {
      user_id: userId,
      balance: result.rows[0].balance,
    };
  } catch (error) {
    console.error('Error updating balance:', error);
    throw error;
  }
}

export async function checkPoolConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection check failed:', error);
    return false;
  }
}
