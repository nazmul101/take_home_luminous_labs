import { ForbiddenError } from '../../../errors/forbidden.error';
import { NotFoundError } from '../../../errors/not-found.error';
import type { Caller } from '../../auth/utils/jwt';
import { encodeCursor, type Cursor } from '../utils/cursor';
import { findOrdersPage, userExists, type OrderRow } from '../repositories/orders.repository';

export interface HistoryRequest {
  caller: Caller;
  targetUserId: number;
  limit: number;
  after?: Cursor | undefined;
}

export interface HistoryPage {
  orders: OrderRow[];
  nextCursor: string | null;
}

/**
 * The whole of requirement 4, as a pure function. No HTTP, no database, no clock -
 * which is why it can be unit tested directly, and is the reason this service layer
 * exists rather than collapsing into the route.
 *
 * Throws rather than returning a boolean or an Error value, so a caller cannot forget
 * to check the result. A dropped `if` here is a silent authorization bypass.
 */
export function assertMayViewOrders(caller: Caller, targetUserId: number): void {
  if (caller.role === 'admin') return;
  if (caller.id === targetUserId) return;
  throw new ForbiddenError();
}

export async function getOrderHistory({
  caller,
  targetUserId,
  limit,
  after,
}: HistoryRequest): Promise<HistoryPage> {
  // Order matters, and this is the most important line in the codebase.
  //
  // Authorizing BEFORE touching the database means a stranger gets 403 whether or not
  // the target user exists - the endpoint reveals nothing. Checking existence first and
  // returning 404 for unknown ids would turn this into a user-enumeration oracle for
  // anyone holding any valid token: probe ids, read the status code, learn the shape of
  // the user table.
  assertMayViewOrders(caller, targetUserId);

  const rows = await findOrdersPage({ userId: targetUserId, limit, after });

  if (rows.length === 0) {
    // Only on the empty path do we pay for an existence check - a non-empty result
    // already proves the user exists. This keeps the extra query off the hot path
    // entirely while still telling "no orders yet" (200, empty array) apart from "no
    // such user" (404).
    //
    // Reachable in practice only for admins: a non-admin who got past the check above
    // is asking about themselves. The exception is a token whose subject has since been
    // deleted - argued to 404 in DECISIONS.md.
    if (!(await userExists(targetUserId))) throw new NotFoundError();

    return { orders: [], nextCursor: null };
  }

  // The repository fetched limit + 1. If the extra row came back there is another page;
  // it is discarded rather than returned, and the cursor is built from the last row
  // actually kept.
  const hasMore = rows.length > limit;
  const orders = hasMore ? rows.slice(0, limit) : rows;
  const last = orders[orders.length - 1];

  return {
    orders,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
