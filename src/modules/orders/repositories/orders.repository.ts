import { db } from '../../../configs/db.config';
import type { Cursor } from '../utils/cursor';

export interface OrderRow {
  id: string;
  product_id: number;
  quantity: number;
  unit_price: string;
  total_price: string;
  status: string;
  created_at: string;
}

interface RawRow extends Omit<OrderRow, 'created_at'> {
  created_at_iso: string;
}

export interface PageQuery {
  userId: number;
  limit: number;
  after?: Cursor | undefined;
}

// created_at is rendered to ISO 8601 text in SQL rather than handed back as a JS Date.
// Postgres timestamptz holds microseconds; a JS Date holds milliseconds. Round-tripping
// the cursor through a Date truncates those microseconds, so the next page's predicate
// fails to exclude the row it was built from and the last row of each page repeats
// forever. Keeping it as text makes the cursor byte-exact with what the database stored.
//
// The alias is `created_at_iso`, NOT `created_at`, and that detail is load bearing.
// Postgres resolves a bare identifier in ORDER BY against the SELECT output names
// first. Aliasing this expression as `created_at` made `ORDER BY created_at DESC` sort
// by the rendered *text* rather than the column - which silently disqualified the index
// and turned every page into a sequential scan plus a sort. The tests still passed,
// because ISO 8601 text sorts the same way as the timestamps it encodes. Only EXPLAIN
// showed it: 347 ms against 0.13 ms.
const SELECT_COLUMNS = `
  id, product_id, quantity, unit_price, total_price, status,
  to_json(created_at) #>> '{}' AS created_at_iso`;

const FIRST_PAGE = `
  SELECT ${SELECT_COLUMNS}
  FROM orders
  WHERE user_id = $1
  ORDER BY created_at DESC, id DESC
  LIMIT $2`;

// Row-value comparison, not the OR expansion that most hand-written keyset code (and
// Prisma) produces. `(created_at, id) < ($3, $4)` is a single range condition the
// planner turns into one index scan; the OR form can plan as a BitmapOr and read more
// rows than it needs to.
const NEXT_PAGE = `
  SELECT ${SELECT_COLUMNS}
  FROM orders
  WHERE user_id = $1
    AND (created_at, id) < ($3::timestamptz, $4::bigint)
  ORDER BY created_at DESC, id DESC
  LIMIT $2`;

const toOrder = ({ created_at_iso, ...rest }: RawRow): OrderRow => ({
  ...rest,
  created_at: created_at_iso,
});

export async function findOrdersPage({ userId, limit, after }: PageQuery): Promise<OrderRow[]> {
  // limit + 1: one extra row is how we learn whether another page exists. The
  // alternative is a second COUNT query per request, which is the exact cost this
  // endpoint is designed to avoid.
  const result = after
    ? await db.query<RawRow>(NEXT_PAGE, [userId, limit + 1, after.createdAt, after.id])
    : await db.query<RawRow>(FIRST_PAGE, [userId, limit + 1]);

  return result.rows.map(toOrder);
}

export async function userExists(userId: number): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  return rowCount === 1;
}
