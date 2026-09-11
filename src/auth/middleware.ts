import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Caller } from './jwt.js';
import { unauthorized } from '../http/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

// Authentication only: proves who is calling. It says nothing about what they may
// read - that decision lives in the service, because it depends on the resource
// being requested and middleware does not know about `:id` semantics.
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get('authorization');

  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('Missing bearer token'));
    return;
  }

  try {
    req.caller = verifyToken(header.slice('Bearer '.length).trim());
    next();
  } catch (err) {
    next(err);
  }
}
