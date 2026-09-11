import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Caller } from '../modules/auth/utils/jwt';
import { UnauthorizedError } from '../errors/unauthorized.error';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Caller;
    }
  }
}

/**
 * Authentication only: proves who is calling. It says nothing about what they may
 * read - that depends on the resource being requested, and middleware does not know
 * what `:id` means. Authorization lives in orders.service.ts, where it can be unit
 * tested without HTTP.
 *
 * A factory rather than a bare handler so the call site reads as a declaration -
 * `wrap(authorization(), getUserOrders)` - and so options (a required role, say) can
 * be added later without touching every route.
 */
export function authorization() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = req.header('Authorization')?.replace('Bearer ', '').trim();

    if (!token) {
      next(new UnauthorizedError('Missing bearer token'));
      return;
    }

    try {
      req.user = verifyToken(token);
      next();
    } catch (err) {
      next(err);
    }
  };
}
