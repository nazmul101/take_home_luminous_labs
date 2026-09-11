import { z } from 'zod';
import { BadRequestError } from '../../../errors/bad-request.error';

export interface Cursor {
  createdAt: string;
  id: string;
}

const payload = z.object({
  c: z.string().min(1),
  i: z.string().regex(/^\d+$/),
});

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt, i: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('Malformed cursor');
  }

  const result = payload.safeParse(parsed);
  if (!result.success) throw new BadRequestError('Malformed cursor');

  return { createdAt: result.data.c, id: result.data.i };
}
