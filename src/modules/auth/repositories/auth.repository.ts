import { db } from '../../../configs/db.config';

export interface AuthUserRow {
  id: number;
  name: string;
  email: string;
  password: string;
  role: string;
}

/**
 * The only place `roles` is joined. The role name is resolved here, once, and carried
 * in the JWT - which is why the order-history path never touches this table.
 *
 * One query, not three: the row either comes back or it does not, and its absence is
 * the same answer a separate COUNT would have given.
 */
export async function findUserByEmail(email: string): Promise<AuthUserRow | null> {
  const { rows } = await db.query<AuthUserRow>(
    `SELECT u.id, u.name, u.email, u.password, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.email = $1`,
    [email],
  );

  return rows[0] ?? null;
}
