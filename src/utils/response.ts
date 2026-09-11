import type { Response } from 'express';

export interface Envelope<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * The one place a success response is shaped, so the envelope cannot drift between
 * endpoints.
 *
 * There is deliberately no `statusCode` field in the body. It would duplicate the HTTP
 * status, and if the two ever disagreed a client would have to pick a winner.
 *
 * `meta` is omitted rather than sent as null when there is nothing to say, so its
 * presence always means something.
 */
export function sendSuccess<T>(
  res: Response,
  payload: { message: string; data: T; meta?: Record<string, unknown>; status?: number },
): void {
  const body: Envelope<T> = {
    success: true,
    message: payload.message,
    data: payload.data,
  };

  if (payload.meta) body.meta = payload.meta;

  res.status(payload.status ?? 200).json(body);
}
