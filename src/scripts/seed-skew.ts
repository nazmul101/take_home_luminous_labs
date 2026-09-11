import { db } from '../configs/db.config';

// Optional. Creates one whale account with ~200,000 orders.
//
// This is the shape real data has: 5M orders across 500k users averages 10 per user,
// but averages are not what breaks. One B2B account with 200k orders is, and it is
// invisible in p50 because 499,999 other users drown it out.
//
// Kept out of `npm run seed` deliberately. A reviewer who just wants the service
// running should not pay for 200k rows; this exists to produce the measurement behind
// the "what breaks at 100x" answer in DECISIONS.md.

const WHALE_USER_ID = 2;
const ORDERS = 200_000;

async function main(): Promise<void> {
  await db.query('SELECT setseed(0.42)');

  const before = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM orders WHERE user_id = $1',
    [WHALE_USER_ID],
  );

  const started = Date.now();

  await db.query(
    `INSERT INTO orders (product_id, user_id, quantity, unit_price, total_price, status, created_at)
     SELECT 1 + floor(random() * 500)::int,
            $1,
            s.quantity,
            s.unit_price,
            round(s.quantity * s.unit_price, 2),
            (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + floor(random() * 5)::int],
            date_trunc('minute', now() - (random() * interval '730 days'))
     FROM (
       SELECT 1 + floor(random() * 5)::int            AS quantity,
              round((random() * 200 + 5)::numeric, 2) AS unit_price
       FROM generate_series(1, $2)
     ) AS s`,
    [WHALE_USER_ID, ORDERS],
  );

  await db.query('ANALYZE orders');

  const after = await db.query<{ count: string }>(
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
  .finally(db.close);
