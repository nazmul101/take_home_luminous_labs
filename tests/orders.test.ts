import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { db } from '../src/configs/db.config';

// Integration against real Postgres, not mocks. What is under test here IS the SQL -
// the ordering, the cursor predicate, the tiebreaker. A mocked repository would assert
// that the code calls the function we wrote, which proves nothing about whether the
// query returns the right rows in the right order.

const app = createApp();

// Fixtures created by `npm run seed`. Identity columns start at 1, so ids are stable.
const ADMIN_ID = 1;
const USER_WITH_ORDERS = 2;
const USER_WITHOUT_ORDERS = 3;
const MISSING_USER = 999_999;
const PASSWORD = 'password123';

let adminToken = '';
let userToken = '';
let emptyUserToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function tokenFor(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}. Run \`npm run setup\` before \`npm test\`.`);
  }
  return res.body.data.token as string;
}

beforeAll(async () => {
  const { rows } = await db.query<{ users: string }>(
    'SELECT count(*)::text AS users FROM users',
  );
  if (rows[0]?.users === '0') {
    throw new Error('Database is empty. Run `npm run setup` before `npm test`.');
  }

  // Tokens come from the real login endpoint rather than being minted directly, so
  // these tests also cover the path a Postman user actually takes.
  [adminToken, userToken, emptyUserToken] = await Promise.all([
    tokenFor('admin@example.com'),
    tokenFor('user@example.com'),
    tokenFor('empty@example.com'),
  ]);
});

afterAll(db.close);

describe('GET /api/users/:id/orders', () => {
  describe('authorization', () => {
    it('401s without a token', async () => {
      await request(app).get(`/api/users/${USER_WITH_ORDERS}/orders`).expect(401);
    });

    it('401s on a token signed with the wrong secret', async () => {
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIiwicm9sZSI6ImFkbWluIn0.' +
        'not-a-valid-signature';
      await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders`)
        .set(auth(forged))
        .expect(401);
    });

    it("403s when a user asks for someone else's orders", async () => {
      await request(app).get(`/api/users/${ADMIN_ID}/orders`).set(auth(userToken)).expect(403);
    });

    it('403s - not 404 - for a user id that does not exist, so existence never leaks', async () => {
      // A non-admin gets the same status whether the target is real or not. If this
      // ever returns 404, the endpoint has become a user-enumeration oracle for anyone
      // holding a valid token.
      await request(app)
        .get(`/api/users/${MISSING_USER}/orders`)
        .set(auth(userToken))
        .expect(403);
    });

    it('lets an admin read another user', async () => {
      await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders`)
        .set(auth(adminToken))
        .expect(200);
    });
  });

  describe('results', () => {
    it('returns orders newest first, with the id tiebreaker respected', async () => {
      const res = await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders?limit=50`)
        .set(auth(userToken))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(1);

      // Assert the full ordering rule, including the tiebreaker - not just that
      // timestamps descend. Sorting by created_at alone would pass a timestamps-only
      // assertion while still producing an unstable cursor.
      const keys = res.body.data.map((o: { created_at: string; id: string }) => [
        o.created_at,
        BigInt(o.id),
      ]);

      for (let i = 1; i < keys.length; i += 1) {
        const [prevTs, prevId] = keys[i - 1];
        const [ts, id] = keys[i];
        expect(prevTs >= ts).toBe(true);
        if (prevTs === ts) expect(prevId > id).toBe(true);
      }
    });

    it('returns the order fields the schema defines', async () => {
      const res = await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders?limit=1`)
        .set(auth(userToken))
        .expect(200);

      const order = res.body.data[0];
      expect(Object.keys(order).sort()).toEqual(
        ['created_at', 'id', 'product_id', 'quantity', 'status', 'total_price', 'unit_price'].sort(),
      );
      // Money crosses the wire as a string: numeric(12,2) does not survive a float.
      expect(order.unit_price).toBeTypeOf('string');
      expect(order.total_price).toBeTypeOf('string');
    });

    it('returns 200 and an empty array for a user with no orders', async () => {
      const res = await request(app)
        .get(`/api/users/${USER_WITHOUT_ORDERS}/orders`)
        .set(auth(emptyUserToken))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.next_cursor).toBeNull();
    });

    it('404s when an admin asks for a user that does not exist', async () => {
      // Distinguishable from the empty case above only because admins are already
      // trusted with knowing which users exist.
      await request(app)
        .get(`/api/users/${MISSING_USER}/orders`)
        .set(auth(adminToken))
        .expect(404);
    });
  });

  describe('pagination', () => {
    it('continues from the cursor with no overlap and no gap', async () => {
      const first = await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders?limit=5`)
        .set(auth(userToken))
        .expect(200);

      expect(first.body.data).toHaveLength(5);
      expect(first.body.meta.next_cursor).toBeTypeOf('string');

      const second = await request(app)
        .get(
          `/api/users/${USER_WITH_ORDERS}/orders?limit=5&cursor=${encodeURIComponent(
            first.body.meta.next_cursor,
          )}`,
        )
        .set(auth(userToken))
        .expect(200);

      const firstIds = first.body.data.map((o: { id: string }) => o.id);
      const secondIds = second.body.data.map((o: { id: string }) => o.id);

      // No overlap: the cursor row itself must not come back. This is the assertion
      // that fails if created_at loses precision on the round trip.
      expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);

      // No gap: a straight limit=10 read must equal page 1 followed by page 2.
      const combined = await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders?limit=10`)
        .set(auth(userToken))
        .expect(200);

      expect([...firstIds, ...secondIds]).toEqual(
        combined.body.data.map((o: { id: string }) => o.id),
      );
    });
  });

  describe('input validation', () => {
    it('400s on a non-numeric id', async () => {
      await request(app).get('/api/users/abc/orders').set(auth(adminToken)).expect(400);
    });

    it('400s on a limit above the maximum', async () => {
      await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders?limit=5000`)
        .set(auth(userToken))
        .expect(400);
    });

    it('400s on a malformed cursor rather than silently restarting', async () => {
      // Silently falling back to page 1 would turn a client bug into an infinite
      // pagination loop that looks like success from the outside.
      await request(app)
        .get(`/api/users/${USER_WITH_ORDERS}/orders?cursor=not-a-real-cursor`)
        .set(auth(userToken))
        .expect(400);
    });
  });
});
