import { db } from '../configs/db.config';

// ~5,000 users and ~50,000 orders, as described in the brief.
//
// Built as set-based INSERTs rather than a loop of parameterised statements. 50,000
// round trips would take minutes; this takes seconds, and the brief grades the
// submission as it arrives if setup takes longer than five minutes.
//
// Fixtures the tests and the Postman collection depend on. Identity columns start at
// 1, so these ids are stable:
//   user 1 - admin@example.com   - admin
//   user 2 - user@example.com    - regular user, guaranteed orders (incl. tied timestamps)
//   user 3 - empty@example.com   - regular user, guaranteed NO orders

const USERS = 5_000;
const ORDERS = 50_000;
const ADMIN_ID = 1;
const FIXTURE_USER_ID = 2;
const EMPTY_USER_ID = 3;

// Plaintext, by explicit instruction. See DECISIONS.md - argued, not overlooked.
const PASSWORD = 'password123';

async function main(): Promise<void> {
  // Reproducible randomness: the benchmark numbers in notes/benchmarks.md are only
  // comparable across runs if the data is identical each time.
  await db.query('SELECT setseed(0.42)');

  await db.query('TRUNCATE orders, users, roles RESTART IDENTITY CASCADE');

  await db.query(`INSERT INTO roles (name) VALUES ('admin'), ('user')`);

  // Named accounts first so their ids are predictable, then the bulk.
  await db.query(
    `INSERT INTO users (name, email, password, role_id) VALUES
       ('Admin User',   'admin@example.com', $1, (SELECT id FROM roles WHERE name = 'admin')),
       ('Regular User', 'user@example.com',  $1, (SELECT id FROM roles WHERE name = 'user')),
       ('Empty User',   'empty@example.com', $1, (SELECT id FROM roles WHERE name = 'user'))`,
    [PASSWORD],
  );

  await db.query(
    `INSERT INTO users (name, email, password, role_id)
     SELECT 'User ' || g,
            'user' || g || '@example.com',
            $2,
            (SELECT id FROM roles WHERE name = 'user')
     FROM generate_series(4, $1) AS g`,
    [USERS, PASSWORD],
  );

  const { rowCount } = await db.query(
    `INSERT INTO orders (product_id, user_id, quantity, unit_price, total_price, status, created_at)
     SELECT s.product_id,
            s.user_id,
            s.quantity,
            s.unit_price,
            -- total_price is stored, not derived: an order is a historical record and
            -- must not move when a product is repriced.
            round(s.quantity * s.unit_price, 2),
            (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + floor(random() * 5)::int],
            -- Truncated to the minute on purpose. Second-resolution timestamps almost
            -- never collide, which would hide the created_at tie that the
            -- (created_at, id) cursor exists to handle. Real systems collide constantly.
            date_trunc('minute', now() - (random() * interval '730 days'))
     FROM (
       SELECT 1 + floor(random() * $1)::int          AS user_id,
              1 + floor(random() * 500)::int         AS product_id,
              1 + floor(random() * 5)::int           AS quantity,
              round((random() * 200 + 5)::numeric, 2) AS unit_price
       FROM generate_series(1, $2)
     ) AS s
     WHERE s.user_id <> $3`,
    [USERS, ORDERS, EMPTY_USER_ID],
  );

  // Deterministic fixture for user 2, on top of whatever the random distribution gave
  // them. Two reasons this is not left to chance. First, random assignment gives that
  // user roughly a dozen orders, uncomfortably close to what the pagination test needs
  // - a fixture that passes by luck fails on someone else's machine. Second, and more
  // important: minute-truncated timestamps spread over 730 days produce almost no
  // collisions, so the id tiebreaker in the sort key would never actually be
  // exercised. These 25 rows land in 5 groups of 5 sharing a timestamp exactly, which
  // makes the tiebreaker load-bearing and the cursor's correctness genuinely tested.
  await db.query(
    `INSERT INTO orders (product_id, user_id, quantity, unit_price, total_price, status, created_at)
     SELECT 100 + i, $1, 2, 25.00, 50.00, 'paid',
            date_trunc('minute', now()) - (floor((i - 1) / 5) * interval '1 minute')
     FROM generate_series(1, 25) AS i`,
    [FIXTURE_USER_ID],
  );

  // ANALYZE, not an afterthought: without fresh statistics the planner may choose a
  // sequential scan on a table it has never seen, which would make the benchmark
  // numbers measure the wrong thing.
  await db.query('ANALYZE roles, users, orders');

  const ties = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT user_id, created_at FROM orders
       GROUP BY user_id, created_at HAVING count(*) > 1
     ) t`,
  );

  console.log(`seeded ${USERS} users, ${rowCount} orders`);
  console.log(`  admin@example.com / ${PASSWORD}  (user ${ADMIN_ID}, admin)`);
  console.log(`  user@example.com  / ${PASSWORD}  (user ${FIXTURE_USER_ID}, has orders)`);
  console.log(`  empty@example.com / ${PASSWORD}  (user ${EMPTY_USER_ID}, no orders)`);
  console.log(`created_at ties within a user: ${ties.rows[0]?.count ?? '0'} groups`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(db.close);
