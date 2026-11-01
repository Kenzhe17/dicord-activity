import { Pool, PoolClient } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export interface User {
  user_id: string; // Discord user_id (string), converted to number for DB bigint column
  balance: number;
}

export async function getUser(userId: string): Promise<User | null> {
  try {
    // Convert Discord user_id (string) to number for bigint column
    const userIdNum = parseInt(userId, 10);
    const result = await pool.query(
      'SELECT user_id, balance FROM user_balance WHERE user_id = $1',
      [userIdNum]
    );
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

export async function createUser(userId: string, initialBalance: number = 0): Promise<User> {
  try {
    // Convert Discord user_id (string) to number for bigint column
    const userIdNum = parseInt(userId, 10);
    const result = await pool.query(
      'INSERT INTO user_balance (user_id, balance) VALUES ($1, $2) RETURNING user_id, balance',
      [userIdNum, initialBalance]
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

export async function getOrCreateUser(userId: string): Promise<User> {
  // For mock users (testing), don't use database
  if (userId.startsWith('mock_')) {
    console.log(`[DB] Using mock user (no DB access): ${userId}`);
    return {
      user_id: userId,
      balance: 0,
    };
  }

  let user = await getUser(userId);
  if (!user) {
    console.log(`[DB] Creating new user in user_balance table: ${userId}`);
    user = await createUser(userId, 0);
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
    // Convert Discord user_id (string) to number for bigint column
    const userIdNum = parseInt(userId, 10);
    const result = await pool.query(
      'UPDATE user_balance SET balance = balance + $1 WHERE user_id = $2 RETURNING user_id, balance',
      [amount, userIdNum]
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
