import { CustomError } from './custom.error';

export class NotFoundError extends CustomError {
  readonly statusCode = 404;
  readonly code = 'not_found';

  constructor(message = 'User not found') {
    super(message);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}
