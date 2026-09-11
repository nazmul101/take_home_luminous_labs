import { CustomError } from './custom.error';

export class UnauthorizedError extends CustomError {
  readonly statusCode = 401;
  readonly code = 'unauthorized';

  constructor(message = 'Authentication required') {
    super(message);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * One message for "no such email" and for "wrong password". Distinguishing them is an
 * account-enumeration oracle, and it would contradict the care taken on the orders
 * path, where 403 is returned before any existence check for exactly this reason.
 */
export class InvalidCredentialsError extends CustomError {
  readonly statusCode = 401;
  readonly code = 'invalid_credentials';

  constructor() {
    super('Invalid email or password');
    Object.setPrototypeOf(this, InvalidCredentialsError.prototype);
  }
}
