import { CustomError } from './custom.error';

export class BadRequestError extends CustomError {
  readonly statusCode = 400;
  readonly code = 'bad_request';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}
