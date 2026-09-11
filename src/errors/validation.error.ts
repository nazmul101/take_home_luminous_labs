import type { ZodIssue } from 'zod';
import { CustomError, type SerializedError } from './custom.error';

/**
 * Wraps a Zod failure so validation reaches the client as a list of per-field
 * messages rather than a single sentence.
 */
export class RequestValidationError extends CustomError {
  readonly statusCode = 400;
  readonly code = 'validation_error';

  constructor(private readonly issues: ZodIssue[]) {
    super('Request validation error');
    Object.setPrototypeOf(this, RequestValidationError.prototype);
  }

  override serializeErrors(): SerializedError[] {
    return this.issues.map((issue) => ({
      message: issue.message,
      field: issue.path.join('.') || undefined,
    }));
  }
}
