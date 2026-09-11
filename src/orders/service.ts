import type { Caller } from '../auth/jwt.js';
import { forbidden, notFound } from '../http/errors.js';
import { encodeCursor, type Cursor } from './cursor.js';
import { findOrdersPage, userExists, type OrderRow } from './repository.js';

export interface HistoryRequest {
  caller: Caller;
  targetUserId: number;
  limit: number;
  after?: Cursor | undefined;
}

export interface HistoryPage {
  data: OrderRow[];
  next_cursor: string | null;
}

/**
 * The whole of requirement 4, as a pure function. No HTTP, no database, no clock
 * - which is why it can be unit tested directly, and is the reason this service
 * layer exists at all rather than collapsing into the controller.
 *
 * Throws rather than returning a boolean so a caller cannot forget to check the
 * result. A dropped `if` here is a silent authorization bypass.
 */
export function assertMayViewOrders(caller: Caller, targetUserId: number): void {
  if (caller.role === 'admin') return;
  if (caller.id === targetUserId) return;
  throw forbidden();
}

export async function getOrderHistory({
  caller,
  targetUserId,
  limit,
  after,
}: HistoryRequest): Promise<HistoryPage> {
  // Order matters, and this is the most important line in the codebase.
  //
  // Authorizing BEFORE touching the database means a stranger gets 403 whether or
  // not the target user exists - the endpoint reveals nothing. Checking existence
  // first and returning 404 for unknown ids would turn this into a user
  // enumeration oracle for anyone holding any valid token: probe ids, read the
  // status code, learn the shape of the user table.
  assertMayViewOrders(caller, targetUserId);

  const rows = await findOrdersPage({ userId: targetUserId, limit, after });

  if (rows.length === 0) {
    // Only now, on the empty path, do we pay for an existence check - a non-empty
    // result already proves the user exists. This keeps the extra query off the
    // hot path entirely while still letting us tell "no orders yet" (200 with an
    // empty array) apart from "no such user" (404).
    //
    // Reachable in practice only for admins: a non-admin who got past the check
    // above is asking about themselves. The exception is a token whose subject has
    // since been deleted - see DECISIONS.md, where that case is argued to 404.
    if (!(await userExists(targetUserId))) throw notFound();

    return { data: [], next_cursor: null };
  }

  // The repository fetched limit + 1. If the extra row came back there is another
  // page; it is discarded rather than returned, and the cursor is built from the
  // last row we actually keep.
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
