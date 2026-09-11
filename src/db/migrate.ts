import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';

// Deliberately not a migration framework. There is one schema file and it is
// applied whole. A versioned migration tool earns its place when a schema has to
// evolve against data you cannot drop; this one is recreated from scratch.
const schemaPath = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

async function main(): Promise<void> {
  const sql = await readFile(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('schema applied');
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
