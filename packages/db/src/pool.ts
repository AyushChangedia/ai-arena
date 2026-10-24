import pg from 'pg';

// Postgres BIGINT (int8, oid 20) is parsed as a string by default; money code converts with BigInt().
// NUMERIC (oid 1700) also stays a string.

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient | pg.Client;

export function createPool(connectionString: string, max = 5): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  pool.on('error', (err) => {
    process.stderr.write(`postgres pool error: ${err.message}\n`);
  });
  return pool;
}

/** Runs fn in a transaction on a dedicated client. Rolls back and rethrows on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      process.stderr.write(`rollback failed: ${(rollbackErr as Error).message}\n`);
    });
    throw e;
  } finally {
    client.release();
  }
}
