import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { db } from '../src/configs/db.config';

const app = createApp();
const PASSWORD = 'password123';

afterAll(db.close);

describe('POST /api/auth/login', () => {
  it('returns a token and the caller identity for an admin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: PASSWORD })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTypeOf('string');
    expect(res.body.data.user.role).toBe('admin');
    // The password must never come back, even though it is stored in plaintext.
    expect(res.body.data.user).not.toHaveProperty('password');
  });

  it('returns a user-role token for an ordinary account', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD })
      .expect(200);

    expect(res.body.data.user.role).toBe('user');
  });

  it('gives the same 401 for an unknown email and for a wrong password', async () => {
    // The point of this test: the two responses must be byte-identical. Any difference
    // between them is an account-enumeration oracle - probe emails, read the error,
    // learn which accounts exist.
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'wrong-password' })
      .expect(401);

    expect(unknown.body).toEqual(wrongPassword.body);
  });

  it('400s on a malformed body', async () => {
    await request(app).post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
  });

  it('400s on a body that is not valid JSON, rather than 500', async () => {
    // Regression test. express.json() throws its own SyntaxError, which fell through
    // the global handler to a 500 - so a client typo looked like a server fault and
    // would have paged whoever was on call. Found by hand with curl, not by the suite.
    await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": broken')
      .expect(400);
  });
});
