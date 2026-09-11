import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { badRequest, unauthorized } from '../http/errors.js';
import { decodeCursor } from './cursor.js';
import { getOrderHistory } from './service.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const params = z.object({
  // Rejected here rather than passed to Postgres as a bad cast. `:id` of "abc" is
  // a client mistake (400), not a database error (500).
  id: z.coerce.number().int().positive(),
});

const query = z.object({
  // Clamped, not just defaulted. An unbounded limit lets one request ask for the
  // whole table, which is a denial-of-service vector dressed up as a feature.
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export async function getUserOrders(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Belt and braces: the route always mounts `authenticate` first, so this is
    // unreachable. It is here because the failure mode if that ever stops being
    // true is "every order history is public", and a thrown 401 is a cheaper way
    // to find that out than a breach.
    if (!req.caller) throw unauthorized();

    const parsedParams = params.safeParse(req.params);
    if (!parsedParams.success) throw badRequest('User id must be a positive integer');

    const parsedQuery = query.safeParse(req.query);
    if (!parsedQuery.success) {
      throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }

    const page = await getOrderHistory({
      caller: req.caller,
      targetUserId: parsedParams.data.id,
      limit: parsedQuery.data.limit,
      // An undecodable cursor is a 400. It is deliberately not treated as "start
      // from the beginning": silently resetting to page 1 turns a client bug into
      // an endless pagination loop that nobody notices.
      after: parsedQuery.data.cursor ? decodeCursor(parsedQuery.data.cursor) : undefined,
    });

    res.json(page);
  } catch (err) {
    next(err);
  }
}
