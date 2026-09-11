import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { appConf } from '../../../configs/app.config';
import { UnauthorizedError } from '../../../errors/unauthorized.error';

export interface Caller {
  id: number;
  role: 'user' | 'admin';
}

// The token is attacker-controlled input even after the signature verifies: a valid
// signature proves the issuer, not the shape. Parsing the claims stops a
// malformed-but-signed token reaching the authorization check as `undefined`.
const claims = z.object({
  sub: z.coerce.number().int().positive(),
  role: z.enum(['user', 'admin']),
});

/**
 * Synchronous on purpose. jwt.sign and jwt.verify are synchronous when no callback is
 * passed; wrapping them in a Promise adds a microtask and an error path without making
 * anything non-blocking.
 */
export function signToken(caller: Caller): string {
  // The role is resolved from the roles table once, at login, and carried in the token.
  // That is why the order-history path never joins `roles`.
  //
  // HS256 with a shared secret is right for a single service. The moment a second
  // service must verify these it becomes RS256 against a JWKS endpoint - and that
  // change is confined to this file.
  return jwt.sign({ role: caller.role }, appConf.JWT_SECRET, {
    subject: String(caller.id),
    algorithm: 'HS256',
    expiresIn: appConf.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): Caller {
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, appConf.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    // The reason is deliberately not echoed back. "Signature invalid" versus "expired"
    // is useful to someone probing tokens and useless to a client, which retries the
    // same way either way.
    throw new UnauthorizedError('Invalid or expired token');
  }

  const parsed = claims.safeParse(decoded);
  if (!parsed.success) throw new UnauthorizedError('Malformed token claims');

  return { id: parsed.data.sub, role: parsed.data.role };
}
