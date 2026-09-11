
# Benchmarks

user 2: 200,036 orders
page size 20, depth 10,000, median of 5 runs

## Keyset vs OFFSET at depth 10,000

| strategy | rows read | planner exec | round trip (median) |
| --- | --- | --- | --- |
| keyset | 20 | 0.21 ms | 2.32 ms |
| OFFSET | 10,020 | 25.72 ms | 22.46 ms |

### keyset plan

```
Limit  (cost=0.42..2.61 rows=20 width=76) (actual time=0.086..0.126 rows=20 loops=1)
  Buffers: shared hit=23
  ->  Index Scan Backward using idx_orders_user_id_created_at_id on orders  (cost=0.42..20781.10 rows=189955 width=76) (actual time=0.085..0.123 rows=20 loops=1)
        Index Cond: ((user_id = 2) AND (ROW(created_at, id) < ROW('2026-08-06 10:32:00+00'::timestamp with time zone, '117343'::bigint)))
        Buffers: shared hit=23
Planning Time: 0.173 ms
Execution Time: 0.213 ms
```

### OFFSET plan

```
Limit  (cost=1040.58..1042.66 rows=20 width=76) (actual time=20.990..21.026 rows=20 loops=1)
  Buffers: shared hit=10127
  ->  Index Scan Backward using idx_orders_user_id_created_at_id on orders  (cost=0.42..20778.95 rows=199763 width=76) (actual time=0.044..20.429 rows=10020 loops=1)
        Index Cond: (user_id = 2)
        Buffers: shared hit=10127
Planning Time: 0.085 ms
Execution Time: 21.091 ms
```

## Same query with the index dropped

```
Limit  (cost=9883.70..9886.00 rows=20 width=76) (actual time=159.966..165.648 rows=20 loops=1)
  Buffers: shared hit=2793
  ->  Gather Merge  (cost=9883.70..22733.57 rows=111738 width=76) (actual time=159.965..165.643 rows=20 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=2793
        ->  Sort  (cost=8883.69..9163.04 rows=111738 width=76) (actual time=156.462..156.464 rows=15 loops=2)
              Sort Key: created_at DESC, id DESC
              Sort Method: top-N heapsort  Memory: 29kB
              Buffers: shared hit=2793
              Worker 0:  Sort Method: top-N heapsort  Memory: 29kB
              ->  Parallel Seq Scan on orders  (cost=0.00..5910.38 rows=111738 width=76) (actual time=0.286..119.073 rows=95018 loops=2)
                    Filter: ((user_id = 2) AND (ROW(created_at, id) < ROW('2026-08-06 10:32:00+00'::timestamp with time zone, '117343'::bigint)))
                    Rows Removed by Filter: 29990
                    Buffers: shared hit=2778
Planning:
  Buffers: shared hit=4
Planning Time: 0.190 ms
Execution Time: 165.820 ms
```

## The COUNT(*) this endpoint does not run

`SELECT count(*) WHERE user_id = 2`: **27.23 ms**
— per page request, against 2.32 ms for the page itself.

## First page: 200 ordinary users vs the skewed account

| | ms |
| --- | --- |
| ordinary users p50 | 2.09 |
| ordinary users p99 | 7.20 |
| user 2, deep page | 2.32 |
| user 2, count(*) | 27.23 |

---

Captured with `npm run bench` after `npm run setup && npm run seed:skew`.
Postgres 16 in Docker on one laptop, everything in cache. Absolute numbers are
machine-specific; the ratios are the point.
