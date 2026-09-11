import 'dotenv/config';
import { z } from 'zod';

// Validated at import time so a missing JWT_SECRET is a startup crash with a
// readable message, not a 500 on the first authenticated request in production.
const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment.\n${issues}\n\nCopy .env.example to .env.`);
}

export const config = parsed.data;
