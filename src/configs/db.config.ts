import pg from 'pg';
import { appConf } from './app.config';

// node-postgres parses int8 (bigint) into a JS number by default, which silently loses
// precision past 2^53. orders.id is bigint, so it is kept as a string all the way to
// JSON. The alternative - letting ids round - is a data corruption bug that only
// appears once the table is large, which is exactly the condition this endpoint is
// supposed to survive.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

// numeric is also returned as a string, by the same reasoning: numeric(12,2) does not
// fit a float without rounding. Anything needing arithmetic on money should do it in
// SQL or with a decimal library, never on a parsed float.

const pool = new pg.Pool({
  connectionString: appConf.DATABASE_URL,
  // Small on purpose. The failure this endpoint is most likely to hit under load is
  // pool exhaustion, and a pool sized far above what Postgres can serve concurrently
  // just moves the queue from the app to the database.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = {
  query: <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) =>
    pool.query<T>(text, params),
  // Exposed for the benchmark, which needs a dedicated connection to drop an index
  // inside a transaction it then rolls back.
  connect: () => pool.connect(),
  // Idempotent. pg-pool throws "Called end on pool more than once" on a second call,
  // which turns an ordinary double-shutdown - an early return plus a .finally, say -
  // into a crash with a stack trace that looks like a real fault. Shutting down twice
  // should be a no-op, not an error.
  close: () => {
    closing ??= pool.end();
    return closing;
  },
};

let closing: Promise<void> | undefined;
