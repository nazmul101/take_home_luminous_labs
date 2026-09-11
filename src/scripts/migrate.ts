import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from '../configs/db.config';

// Deliberately not a migration framework. There is one schema file and it is applied
// whole. A versioned migration tool earns its place when a schema must evolve against
// data you cannot drop; this one is recreated from scratch.
const schemaPath = fileURLToPath(new URL('../entities/schema.sql', import.meta.url));

async function main(): Promise<void> {
  await db.query(await readFile(schemaPath, 'utf8'));
  console.log('schema applied');
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(db.close);
