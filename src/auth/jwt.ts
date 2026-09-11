import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { unauthorized } from '../http/errors.js';

export interface Caller {
  id: number;
  role: 'user' | 'admin';
}

// The token is attacker-controlled input even after the signature verifies - a
// valid signature proves the issuer, not the shape. Parsing the claims keeps a
// malformed-but-signed token from reaching the authorization check as `undefined`.
const claims = z.object({
  sub: z.coerce.number().int().positive(),
  role: z.enum(['user', 'admin']),
});

export function verifyToken(token: string): Caller {
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    // The reason is deliberately not echoed back. "Signature invalid" versus
    // "expired" is useful to an attacker probing tokens and useless to a client,
    // which retries the same way either way.
    throw unauthorized('Invalid or expired token');
  }

  const parsed = claims.safeParse(decoded);
  if (!parsed.success) throw unauthorized('Malformed token claims');

  return { id: parsed.data.sub, role: parsed.data.role };
}

export function signToken(caller: Caller, expiresIn = '1h'): string {
  // HS256 with a shared secret is right for a single service. The moment a second
  // service needs to verify these, this becomes RS256 against a JWKS endpoint -
  // and that change is confined to this file.
  return jwt.sign({ role: caller.role }, config.JWT_SECRET, {
    subject: String(caller.id),
    algorithm: 'HS256',
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });
}
