import { Pool, PoolClient } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export interface User {
  user_id: string;
  balance: number;
}

export async function getUser(userId: string): Promise<User | null> {
  try {
    const result = await pool.query(
      'SELECT user_id, balance FROM user_balance WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error fetching user:', error);
    return null;
  }
}

export async function createUser(userId: string, initialBalance: number = 0): Promise<User> {
  try {
    const result = await pool.query(
      'INSERT INTO user_balance (user_id, balance) VALUES ($1, $2) RETURNING user_id, balance',
      [userId, initialBalance]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Error creating user:', error);
    throw error;
  }
}

export async function getOrCreateUser(userId: string): Promise<User> {
  let user = await getUser(userId);
  if (!user) {
    console.log(`[DB] Creating new user in user_balance table: ${userId}`);
    user = await createUser(userId, 0);
  }
  return user;
}

export async function updateBalance(userId: string, amount: number): Promise<User> {
  try {
    const result = await pool.query(
      'UPDATE user_balance SET balance = balance + $1 WHERE user_id = $2 RETURNING user_id, balance',
      [amount, userId]
    );
    return result.rows[0];
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
