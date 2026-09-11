import pg from 'pg';
import { config } from '../config.js';

// node-postgres parses int8 (bigint) into a JS number by default, which silently
// loses precision past 2^53. orders.id is bigint, so it is returned as a string
// and serialised as a string. The alternative - letting ids round - is a data
// corruption bug that only appears once the table is large, which is exactly the
// kind of failure this endpoint is supposed to survive.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

// numeric is also returned as a string, by the same reasoning: numeric(12,2) does
// not fit a float without rounding. Callers that need arithmetic on money should
// do it in SQL or with a decimal library, not on a parsed float.

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // Small on purpose. The failure mode this endpoint is most likely to hit under
  // load is pool exhaustion, and a pool sized far above what Postgres can serve
  // concurrently just moves the queue from the app to the database.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
