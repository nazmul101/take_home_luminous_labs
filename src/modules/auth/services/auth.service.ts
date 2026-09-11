import { InvalidCredentialsError } from '../../../errors/unauthorized.error';
import { findUserByEmail } from '../repositories/auth.repository';
import { signToken, type Caller } from '../utils/jwt';

export interface LoginResult {
  token: string;
  user: { id: number; name: string; email: string; role: string };
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await findUserByEmail(email);

  // Unknown email and wrong password produce the identical error, deliberately.
  // Returning "no such account" for one and "wrong password" for the other is an
  // account-enumeration oracle - the same class of leak the orders endpoint avoids by
  // authorizing before checking existence. Guarding one and not the other would be
  // inconsistent.
  //
  // PLAINTEXT COMPARISON, by explicit instruction. In anything real this is
  // `bcrypt.compare`, which is also constant-time; `!==` on a secret is
  // timing-attackable in principle. Documented in DECISIONS.md rather than hidden, and
  // it is the one line here I would not ship.
  //
  // Thrown, never returned as a value. A service that returns `new Error(...)` relies
  // on every caller remembering to check the result, and a missed check here is a
  // silent authentication bypass.
  if (!user || user.password !== password) throw new InvalidCredentialsError();

  // Anything not in the roles table is treated as an ordinary user. A role name the
  // token schema does not recognise must never be silently promoted.
  const role: Caller['role'] = user.role === 'admin' ? 'admin' : 'user';

  return {
    token: signToken({ id: user.id, role }),
    user: { id: user.id, name: user.name, email: user.email, role },
  };
}
