import { pool, closePool } from './pool.js';

// Produces the numbers quoted in DECISIONS.md. Nothing here is load testing - it
// measures single-query cost, which is the thing the design claims to control.
//
// Run after `npm run seed`. Run `npm run seed:skew` first for the skew section to
// be meaningful.

const USER = 2;
const DEPTH = 10_000; // how far into the history to page
const PAGE = 20;
const RUNS = 5;

interface Plan {
  ms: number;
  rows: number;
  text: string;
}

async function explain(sql: string, params: unknown[]): Promise<Plan> {
  const { rows } = await pool.query<{ 'QUERY PLAN': unknown[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  );

  const plan = (rows[0]?.['QUERY PLAN'] as Array<Record<string, any>>)[0]!;

  const { rows: textRows } = await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    params,
  );

  return {
    ms: plan['Execution Time'] as number,
    // Rows actually read by the scan node, not rows returned. This is the number
    // that separates the two strategies: both return 20.
    rows: countScannedRows(plan['Plan']),
    text: textRows.map((r) => r['QUERY PLAN']).join('\n'),
  };
}

function countScannedRows(node: Record<string, any>): number {
  const self = ((node['Actual Rows'] as number) ?? 0) * ((node['Actual Loops'] as number) ?? 1);
  const children = (node['Plans'] as Array<Record<string, any>>) ?? [];
  // Leaf scan nodes only - summing every level would double count.
  return children.length === 0
    ? self
    : children.reduce((sum, child) => sum + countScannedRows(child), 0);
}

async function timeIt(sql: string, params: unknown[]): Promise<number> {
  const timings: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = process.hrtime.bigint();
    await pool.query(sql, params);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)]!;
}

const KEYSET = `
  SELECT id, status, total_amount, to_json(created_at) #>> '{}' AS created_at_iso
  FROM orders
  WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::bigint)
  ORDER BY created_at DESC, id DESC
  LIMIT $4`;

const OFFSET_SQL = `
  SELECT id, status, total_amount, to_json(created_at) #>> '{}' AS created_at_iso
  FROM orders
  WHERE user_id = $1
  ORDER BY created_at DESC, id DESC
  LIMIT $2 OFFSET $3`;

async function main(): Promise<void> {
  const total = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM orders WHERE user_id = $1',
    [USER],
  );
  const orderCount = Number(total.rows[0]!.count);

  console.log(`# Benchmarks\n`);
  console.log(`user ${USER}: ${orderCount.toLocaleString()} orders`);
  console.log(`page size ${PAGE}, depth ${DEPTH.toLocaleString()}, median of ${RUNS} runs\n`);

  if (orderCount < DEPTH + PAGE) {
    console.log(`> Only ${orderCount} orders. Run \`npm run seed:skew\` for a meaningful depth.\n`);
    await closePool();
    return;
  }

  // The cursor that points DEPTH rows in. Derived with OFFSET on purpose: this is
  // setup, not the measurement, and it is the honest way to put both strategies
  // at the same position in the same ordering.
  const anchor = await pool.query<{ created_at: string; id: string }>(
    `SELECT to_json(created_at) #>> '{}' AS created_at, id
     FROM orders WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1 OFFSET $2`,
    [USER, DEPTH],
  );
  const cursor = anchor.rows[0]!;

  const keysetPlan = await explain(KEYSET, [USER, cursor.created_at, cursor.id, PAGE]);
  const offsetPlan = await explain(OFFSET_SQL, [USER, PAGE, DEPTH]);
  const keysetMs = await timeIt(KEYSET, [USER, cursor.created_at, cursor.id, PAGE]);
  const offsetMs = await timeIt(OFFSET_SQL, [USER, PAGE, DEPTH]);

  console.log(`## Keyset vs OFFSET at depth ${DEPTH.toLocaleString()}\n`);
  console.log('| strategy | rows read | planner exec | round trip (median) |');
  console.log('| --- | --- | --- | --- |');
  console.log(
    `| keyset | ${keysetPlan.rows.toLocaleString()} | ${keysetPlan.ms.toFixed(2)} ms | ${keysetMs.toFixed(2)} ms |`,
  );
  console.log(
    `| OFFSET | ${offsetPlan.rows.toLocaleString()} | ${offsetPlan.ms.toFixed(2)} ms | ${offsetMs.toFixed(2)} ms |`,
  );
  console.log(`\n### keyset plan\n\n\`\`\`\n${keysetPlan.text}\n\`\`\`\n`);
  console.log(`### OFFSET plan\n\n\`\`\`\n${offsetPlan.text}\n\`\`\`\n`);

  // What the index is actually worth. Dropped and restored inside a transaction
  // that is rolled back, so a failure here cannot leave the database without it.
  console.log(`## Same query with the index dropped\n`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP INDEX idx_orders_user_id_created_at_id');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${KEYSET}`,
      [USER, cursor.created_at, cursor.id, PAGE],
    );
    console.log(`\`\`\`\n${rows.map((r) => r['QUERY PLAN']).join('\n')}\n\`\`\`\n`);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  // The count that is deliberately not in the response.
  const countMs = await timeIt('SELECT count(*) FROM orders WHERE user_id = $1', [USER]);
  console.log(`## The COUNT(*) this endpoint does not run\n`);
  console.log(`\`SELECT count(*) WHERE user_id = ${USER}\`: **${countMs.toFixed(2)} ms**`);
  console.log(`— per page request, against ${keysetMs.toFixed(2)} ms for the page itself.\n`);

  // p50 across ordinary users, to show the skew is invisible in an average.
  const sample = await pool.query<{ id: number }>(
    'SELECT id FROM users WHERE id <> $1 ORDER BY id LIMIT 200',
    [USER],
  );
  const normal: number[] = [];
  for (const { id } of sample.rows) {
    normal.push(await timeIt(`${OFFSET_SQL.replace('OFFSET $3', 'OFFSET 0')}`, [id, PAGE]));
  }
  normal.sort((a, b) => a - b);

  console.log(`## First page: 200 ordinary users vs the skewed account\n`);
  console.log(`| | ms |`);
  console.log(`| --- | --- |`);
  console.log(`| ordinary users p50 | ${normal[Math.floor(normal.length * 0.5)]!.toFixed(2)} |`);
  console.log(`| ordinary users p99 | ${normal[Math.floor(normal.length * 0.99)]!.toFixed(2)} |`);
  console.log(`| user ${USER}, deep page | ${keysetMs.toFixed(2)} |`);
  console.log(`| user ${USER}, count(*) | ${countMs.toFixed(2)} |`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
