import { CustomError } from './custom.error';

export class ForbiddenError extends CustomError {
  readonly statusCode = 403;
  readonly code = 'forbidden';

  constructor(message = 'You may not view these orders') {
    super(message);
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}
