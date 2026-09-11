import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Composes a chain of handlers into one and captures async rejections into `next`, so
 * they reach the error handler.
 *
 * Used at the route so the whole chain is declared in one place:
 *
 *   router.get('/users/:id/orders', wrap(authorization(), getUserOrders));
 *
 * The guarantee that matters: if a handler throws, rejects, or sends a response, the
 * rest of the chain does not run. An authentication failure provably cannot fall
 * through into the handler that reads orders.
 */
export function wrap(...handlers: RequestHandler[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    for (const handler of handlers) {
      const outcome = await runHandler(handler, req, res);

      if (outcome.kind === 'error') {
        next(outcome.error);
        return;
      }

      // The handler answered the request itself. Nothing after it should run, and
      // calling next() here would risk a second response on the same request.
      if (outcome.kind === 'handled') return;
    }
  };
}

type Outcome = { kind: 'next' } | { kind: 'handled' } | { kind: 'error'; error: unknown };

function runHandler(handler: RequestHandler, req: Request, res: Response): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const next = (err?: unknown): void => {
      resolve(err ? { kind: 'error', error: err } : { kind: 'next' });
    };

    // `finish` covers a handler that responds without calling next - the login route,
    // for example. Without it this promise would never settle and the request hangs.
    res.once('finish', () => resolve({ kind: 'handled' }));

    try {
      const result = handler(req, res, next as NextFunction);
      if (result instanceof Promise) {
        result.catch((error: unknown) => resolve({ kind: 'error', error }));
      }
    } catch (error) {
      resolve({ kind: 'error', error });
    }
  });
}
