import { describe, expect, it } from 'vitest';
import { assertMayViewOrders } from '../src/orders/service.js';
import { AppError } from '../src/http/errors.js';

// No HTTP, no database, no fixtures. This is the entire justification for the
// service layer existing rather than being folded into the controller: the rule in
// requirement 4 is the highest-risk logic here, and it is worth testing without
// anything else in the way.

const user = (id: number) => ({ id, role: 'user' as const });
const admin = (id: number) => ({ id, role: 'admin' as const });

describe('assertMayViewOrders', () => {
  it('allows a user to view their own orders', () => {
    expect(() => assertMayViewOrders(user(7), 7)).not.toThrow();
  });

  it('allows an admin to view anyone', () => {
    expect(() => assertMayViewOrders(admin(1), 7)).not.toThrow();
  });

  it('refuses a user viewing someone else', () => {
    expect(() => assertMayViewOrders(user(7), 8)).toThrow(AppError);
  });

  it('refuses with 403 rather than 404, for any target id', () => {
    // The status must not depend on whether the target exists. This test encodes
    // that: 7 and 999_999_999 are treated identically, so the response cannot be
    // used to probe which user ids are real.
    for (const target of [8, 999_999_999]) {
      try {
        assertMayViewOrders(user(7), target);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as AppError).status).toBe(403);
      }
    }
  });
});
