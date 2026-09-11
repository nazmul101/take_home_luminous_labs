import { pool, closePool } from './pool.js';

// Optional. Creates one whale account with ~200,000 orders.
//
// This is the shape real data has: 5M orders across 500k users is an average of
// 10 per user, but averages are not what breaks. One B2B account with 200k orders
// is, and it is invisible in p50 because 499,999 other users drown it out.
//
// Kept out of `npm run seed` deliberately. A reviewer who just wants the service
// running should not pay for 200k rows; this exists to produce the measurement
// behind the "what breaks at 100x" answer in DECISIONS.md.

const WHALE_USER_ID = 2;
const ORDERS = 200_000;

async function main(): Promise<void> {
  await pool.query('SELECT setseed(0.42)');

  const before = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM orders WHERE user_id = $1',
    [WHALE_USER_ID],
  );

  const started = Date.now();

  await pool.query(
    `INSERT INTO orders (user_id, status, total_amount, created_at)
     SELECT $1,
            (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + floor(random() * 5)::int],
            round((random() * 500 + 5)::numeric, 2),
            date_trunc('minute', now() - (random() * interval '730 days'))
     FROM generate_series(1, $2)`,
    [WHALE_USER_ID, ORDERS],
  );

  await pool.query('ANALYZE orders');

  const after = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM orders WHERE user_id = $1',
    [WHALE_USER_ID],
  );

  console.log(
    `user ${WHALE_USER_ID}: ${before.rows[0]?.count} -> ${after.rows[0]?.count} orders ` +
      `in ${Date.now() - started}ms`,
  );
  console.log('run `npm run bench` to measure the difference');
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
