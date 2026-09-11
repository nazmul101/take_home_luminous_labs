export interface SerializedError {
  message: string;
  field?: string;
}

/**
 * Base for every failure this service produces deliberately. Anything reaching the
 * error handler that is NOT a CustomError is a bug, and is reported as an opaque 500.
 *
 * `statusCode` is abstract rather than a constructor argument so that each error type
 * owns its status in one place - a caller cannot accidentally throw a NotFoundError
 * with a 200 on it.
 */
export abstract class CustomError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, CustomError.prototype);
  }

  serializeErrors(): SerializedError[] {
    return [{ message: this.message }];
  }
}
