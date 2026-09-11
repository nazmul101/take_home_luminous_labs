
# Benchmarks

user 2: 200,036 orders
page size 20, depth 10,000, median of 5 runs

## Keyset vs OFFSET at depth 10,000

| strategy | rows read | planner exec | round trip (median) |
| --- | --- | --- | --- |
| keyset | 20 | 0.18 ms | 3.72 ms |
| OFFSET | 10,020 | 18.15 ms | 39.45 ms |

### keyset plan

```
Limit  (cost=0.42..2.30 rows=20 width=62) (actual time=0.040..0.075 rows=20 loops=1)
  Buffers: shared hit=23
  ->  Index Scan Backward using idx_orders_user_id_created_at_id on orders  (cost=0.42..17843.54 rows=189555 width=62) (actual time=0.039..0.073 rows=20 loops=1)
        Index Cond: ((user_id = 2) AND (ROW(created_at, id) < ROW('2026-08-04 19:21:00+00'::timestamp with time zone, '116396'::bigint)))
        Buffers: shared hit=23
Planning Time: 0.077 ms
Execution Time: 0.130 ms
```

### OFFSET plan

```
Limit  (cost=894.19..895.98 rows=20 width=62) (actual time=25.482..25.528 rows=20 loops=1)
  Buffers: shared hit=10133
  ->  Index Scan Backward using idx_orders_user_id_created_at_id on orders  (cost=0.42..17871.68 rows=199954 width=62) (actual time=0.047..24.635 rows=10020 loops=1)
        Index Cond: (user_id = 2)
        Buffers: shared hit=10133
Planning Time: 0.091 ms
Execution Time: 25.615 ms
```

## Same query with the index dropped

```
Limit  (cost=9139.27..9141.57 rows=20 width=62) (actual time=338.253..346.082 rows=20 loops=1)
  Buffers: shared hit=2056
  ->  Gather Merge  (cost=9139.27..21962.12 rows=111503 width=62) (actual time=338.244..346.067 rows=20 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=2056
        ->  Sort  (cost=8139.26..8418.02 rows=111503 width=62) (actual time=322.239..322.244 rows=17 loops=2)
              Sort Key: created_at DESC, id DESC
              Sort Method: top-N heapsort  Memory: 29kB
              Buffers: shared hit=2056
              Worker 0:  Sort Method: top-N heapsort  Memory: 29kB
              ->  Parallel Seq Scan on orders  (cost=0.00..5172.21 rows=111503 width=62) (actual time=2.130..254.752 rows=95018 loops=2)
                    Filter: ((user_id = 2) AND (ROW(created_at, id) < ROW('2026-08-04 19:21:00+00'::timestamp with time zone, '116396'::bigint)))
                    Rows Removed by Filter: 29990
                    Buffers: shared hit=2041
Planning:
  Buffers: shared hit=4
Planning Time: 0.558 ms
Execution Time: 346.427 ms
```

## The COUNT(*) this endpoint does not run

`SELECT count(*) WHERE user_id = 2`: **37.66 ms**
— per page request, against 3.72 ms for the page itself.

## First page: 200 ordinary users vs the skewed account

| | ms |
| --- | --- |
| ordinary users p50 | 2.67 |
| ordinary users p99 | 3.47 |
| user 2, deep page | 3.72 |
| user 2, count(*) | 37.66 |

---

Captured with `npm run bench` after `npm run setup && npm run seed:skew`.
Postgres 16 in Docker on one laptop, everything in cache. Absolute numbers are
machine-specific; the ratios are the point.
