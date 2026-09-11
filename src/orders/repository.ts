import { pool } from '../db/pool.js';
import type { Cursor } from './cursor.js';

export interface OrderRow {
  id: string;
  status: string;
  total_amount: string;
  created_at: string;
}

interface RawRow {
  id: string;
  status: string;
  total_amount: string;
  created_at_iso: string;
}

export interface PageQuery {
  userId: number;
  limit: number;
  after?: Cursor | undefined;
}

// created_at is rendered to ISO 8601 text in SQL rather than handed back as a JS
// Date. Postgres timestamptz holds microseconds; a JS Date holds milliseconds.
// Round-tripping the cursor through a Date truncates those microseconds, so the
// next page's predicate fails to exclude the row it was built from and the last
// row of each page repeats forever. Keeping it as text makes the cursor
// byte-exact with what the database stored.
//
// The alias is `created_at_iso`, NOT `created_at`, and that detail is load
// bearing. Postgres resolves a bare identifier in ORDER BY against the SELECT
// output names first. Aliasing this expression as `created_at` made
// `ORDER BY created_at DESC` sort by the rendered *text* rather than the column -
// which silently disqualified the index and turned every page into a sequential
// scan plus a sort. The tests still passed, because ISO 8601 text happens to sort
// the same way as the timestamps it encodes. Only EXPLAIN showed it.
const SELECT_COLUMNS = `id, status, total_amount, to_json(created_at) #>> '{}' AS created_at_iso`;

const FIRST_PAGE = `
  SELECT ${SELECT_COLUMNS}
  FROM orders
  WHERE user_id = $1
  ORDER BY created_at DESC, id DESC
  LIMIT $2`;

// Row-value comparison, not the OR expansion that Prisma and most hand-written
// keyset code produce. `(created_at, id) < ($3, $4)` is a single range condition
// the planner turns into one index scan; the OR form can plan as a BitmapOr and
// read more rows than it needs to.
const NEXT_PAGE = `
  SELECT ${SELECT_COLUMNS}
  FROM orders
  WHERE user_id = $1
    AND (created_at, id) < ($3::timestamptz, $4::bigint)
  ORDER BY created_at DESC, id DESC
  LIMIT $2`;

const toOrder = (row: RawRow): OrderRow => ({
  id: row.id,
  status: row.status,
  total_amount: row.total_amount,
  created_at: row.created_at_iso,
});

export async function findOrdersPage({ userId, limit, after }: PageQuery): Promise<OrderRow[]> {
  // limit + 1: fetching one extra row is how we learn whether another page
  // exists. The alternative is a second COUNT query per request, which is the
  // exact cost this endpoint is designed to avoid.
  const result = after
    ? await pool.query<RawRow>(NEXT_PAGE, [userId, limit + 1, after.createdAt, after.id])
    : await pool.query<RawRow>(FIRST_PAGE, [userId, limit + 1]);

  return result.rows.map(toOrder);
}

export async function userExists(userId: number): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  return rowCount === 1;
}
