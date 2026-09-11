import type { NextFunction, Request, Response } from 'express';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'unauthorized', msg);

export const forbidden = (msg = 'You may not view these orders') =>
  new AppError(403, 'forbidden', msg);

export const notFound = (msg = 'User not found') => new AppError(404, 'not_found', msg);

export const badRequest = (msg: string) => new AppError(400, 'bad_request', msg);

// Single place that turns an error into a response, so no handler has to remember
// the shape. Anything that is not an AppError is a bug, not a client mistake:
// it is logged in full and reported as an opaque 500, because leaking a Postgres
// error string to a caller tells them about the schema.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies
  // error middleware by arity; dropping `next` silently turns this into a normal handler.
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  console.error('unhandled error', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}
