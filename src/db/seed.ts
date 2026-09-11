import { pool, closePool } from './pool.js';

// ~5,000 users and ~50,000 orders, as described in the brief.
//
// Built as two set-based INSERTs rather than a loop of parameterised inserts.
// 50,000 round trips would take minutes; this takes about a second, and the brief
// grades the submission as it arrives if setup takes longer than five minutes.
//
// Fixtures the tests depend on (ids are stable because identity starts at 1):
//   user 1 - admin
//   user 2 - regular user, guaranteed to have orders
//   user 3 - regular user, guaranteed to have NO orders (the empty-history case)

const USERS = 5_000;
const ORDERS = 50_000;
const FIXTURE_USER_ID = 2;
const EMPTY_USER_ID = 3;

async function main(): Promise<void> {
  // Reproducible randomness: benchmark numbers recorded in notes/benchmarks.md
  // are only comparable across runs if the data is identical each time.
  await pool.query('SELECT setseed(0.42)');

  await pool.query('TRUNCATE orders, users RESTART IDENTITY CASCADE');

  await pool.query(
    `INSERT INTO users (email, role)
     SELECT 'user' || g || '@example.com',
            CASE WHEN g = 1 THEN 'admin' ELSE 'user' END
     FROM generate_series(1, $1) AS g`,
    [USERS],
  );

  const { rowCount } = await pool.query(
    `INSERT INTO orders (user_id, status, total_amount, created_at)
     SELECT s.user_id,
            (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + floor(random() * 5)::int],
            round((random() * 500 + 5)::numeric, 2),
            -- Truncated to the minute on purpose. Second-resolution timestamps
            -- almost never collide, which would hide the created_at tie that the
            -- (created_at, id) cursor exists to handle. Real systems collide
            -- constantly - bulk imports, batch jobs, retries.
            date_trunc('minute', now() - (random() * interval '730 days'))
     FROM (
       SELECT 1 + floor(random() * $1)::int AS user_id
       FROM generate_series(1, $2)
     ) AS s
     WHERE s.user_id <> $3`,
    [USERS, ORDERS, EMPTY_USER_ID],
  );

  // Deterministic fixture for user 2, on top of whatever the random distribution
  // gave them.
  //
  // Two reasons this is not left to chance. First, random assignment gave user 2
  // about 11 orders, which is uncomfortably close to the 10 the pagination test
  // needs - a fixture that passes by luck will fail on someone else's machine.
  // Second, and more important: minute-truncated timestamps spread over 730 days
  // produce almost no created_at collisions, so the id tiebreaker in the sort key
  // would never actually be exercised. These 25 rows land in 5 groups of 5
  // sharing a timestamp exactly, which makes the tiebreaker load-bearing and the
  // cursor's correctness genuinely tested.
  await pool.query(
    `INSERT INTO orders (user_id, status, total_amount, created_at)
     SELECT $1,
            'paid',
            round((10 + i)::numeric, 2),
            date_trunc('minute', now()) - (floor((i - 1) / 5) * interval '1 minute')
     FROM generate_series(1, 25) AS i`,
    [FIXTURE_USER_ID],
  );

  // ANALYZE, not an afterthought: without fresh statistics the planner may pick a
  // sequential scan on a table it has never seen, which would make the benchmark
  // numbers in DECISIONS.md measure the wrong thing.
  await pool.query('ANALYZE users, orders');

  const ties = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT user_id, created_at FROM orders
       GROUP BY user_id, created_at HAVING count(*) > 1
     ) t`,
  );

  console.log(`seeded ${USERS} users, ${rowCount} orders`);
  console.log(`user 1 = admin, user ${FIXTURE_USER_ID} = has orders (incl. deliberate ties), user ${EMPTY_USER_ID} = none`);
  console.log(`created_at ties within a user: ${ties.rows[0]?.count ?? '0'} groups`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
