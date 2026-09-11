import { z } from 'zod';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const orderParamsSchema = z.object({
  // Rejected here rather than passed to Postgres as a bad cast. An `:id` of "abc" is a
  // client mistake (400), not a database error (500).
  id: z.coerce.number({ invalid_type_error: 'User id must be a positive integer' })
    .int('User id must be a positive integer')
    .positive('User id must be a positive integer'),
});

export const orderQuerySchema = z.object({
  // Clamped, not merely defaulted. An unbounded limit lets one request ask for the
  // whole table - a denial-of-service vector dressed up as a feature.
  limit: z.coerce
    .number()
    .int(`limit must be an integer between 1 and ${MAX_LIMIT}`)
    .positive(`limit must be an integer between 1 and ${MAX_LIMIT}`)
    .max(MAX_LIMIT, `limit must be an integer between 1 and ${MAX_LIMIT}`)
    .default(DEFAULT_LIMIT),
  cursor: z.string().min(1, 'cursor must not be empty').optional(),
});
