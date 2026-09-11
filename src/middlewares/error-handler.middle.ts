import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { CustomError } from '../errors/custom.error';
import { RequestValidationError } from '../errors/validation.error';

/**
 * The single place an error becomes a response, so no route has to remember the shape.
 *
 * Registered LAST in app.ts, after every route. Express matches middleware in
 * registration order and identifies error handlers by their four-parameter arity -
 * mount this before the routes and it silently never runs.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // Dropping `next` changes the arity and turns this into an ordinary middleware.
  _next: NextFunction,
): void {
  if (err instanceof CustomError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      errors: err.serializeErrors(),
      code: err.code,
    });
    return;
  }

  // A Zod error that escaped a validator is a validation gap, not a server fault.
  if (err instanceof ZodError) {
    const wrapped = new RequestValidationError(err.issues);
    res.status(wrapped.statusCode).json({
      success: false,
      message: wrapped.message,
      errors: wrapped.serializeErrors(),
      code: wrapped.code,
    });
    return;
  }

  // express.json() rejects a malformed body with a SyntaxError carrying
  // `type: 'entity.parse.failed'`. Without this branch it falls through to the 500
  // below - so a client sending broken JSON would look like a server fault, page
  // whoever is on call, and bury a real outage in noise. Found by hand with curl, not
  // by the tests: see notes/ai-log.md.
  if (isBodyParseError(err)) {
    res.status(400).json({
      success: false,
      message: 'Request body is not valid JSON',
      errors: [{ message: 'Request body is not valid JSON' }],
      code: 'bad_request',
    });
    return;
  }

  // Everything else is a bug. Log it in full, tell the client nothing: a Postgres error
  // string describes the schema to whoever asked for it.
  console.error('[ERROR] Unhandled:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    errors: [{ message: 'Something went wrong' }],
    code: 'internal_error',
  });
}

/**
 * body-parser signals a malformed payload with a plain Error decorated with `type`.
 * There is no exported class to instanceof against, so the shape is checked directly
 * rather than matching on the message text.
 */
function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  );
}
