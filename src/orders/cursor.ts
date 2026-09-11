import { z } from 'zod';
import { badRequest } from '../http/errors.js';

export interface Cursor {
  createdAt: string;
  id: string;
}

// Shape is validated on decode because a cursor is client-supplied input. It is
// base64 to signal "opaque, do not construct these yourself", not to hide
// anything - it is trivially readable and is not a security boundary. The values
// inside it are only ever used as bound parameters, never interpolated.
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
    throw badRequest('Malformed cursor');
  }

  const result = payload.safeParse(parsed);
  if (!result.success) throw badRequest('Malformed cursor');

  return { createdAt: result.data.c, id: result.data.i };
}
