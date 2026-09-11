# DECISIONS

`GET /api/users/:id/orders` — order history, keyset-paginated, self-or-admin.

**Stopped at roughly 2h45.** The brief calls 2–3 hours a ceiling, so this is a
deliberate stopping point rather than a running-out-of-time point. What I chose not
to build is in question 4, and each omission has a trigger that would make me build
it.

All performance numbers below come from `npm run bench` and are reproducible;
raw query plans are in [`notes/benchmarks.md`](notes/benchmarks.md).

---

## 1. What did the requirements not tell you?

The brief gave four sentences. Everything below is a decision I made in the gaps.

### About the data

**A schema and seed script were described as "provided" but were not attached.** I
wrote both. That makes every column an assumption, and three of them change the
code:

1. **Integer surrogate keys, not UUIDs.** Affects `:id` validation and cursor
   encoding. With UUIDv4 the `(created_at, id)` tiebreaker still works, but the id
   is no longer monotonic, so "newest" would rest entirely on `created_at`.
2. **`orders.created_at` is `NOT NULL`.** Load-bearing, not cosmetic. The cursor
   predicate is `(created_at, id) < ($3, $4)`; a NULL `created_at` makes that
   comparison NULL, the row fails the `WHERE`, and **the order silently vanishes
   from the user's history** — no error, no log line. If the real schema allows
   nulls, this endpoint loses rows and nobody finds out. I enforced the constraint
   rather than coding around it.
3. **`role` is a column on `users`,** not a join table or a permissions service.

Also assumed: no soft deletes (no `deleted_at` filter), and `created_at` is the
right meaning of "newest" — not `placed_at`, `updated_at`, or a status transition
time. In a real order system "newest" is genuinely ambiguous and I would ask.

### About the API

4. **"Newest first" is `created_at DESC, id DESC`.** The `id` tiebreaker is not
   decoration: ties on `created_at` are ordinary in bulk imports and batch jobs,
   and without a tiebreaker the ordering is non-deterministic, which makes the
   cursor unsound. The seed deliberately creates tied timestamps so the tests
   actually exercise this.
5. **Pagination exists at all,** and is cursor-based. Requirement 2 says "must stay
   responsive as the number of orders grows" without saying how.
6. **Empty history is `200` with an empty array, not `404`.** "No orders yet" is a
   successful answer to a valid question.
7. **An order is its header** — id, status, total, timestamp. No line items.
8. **Money is a JSON string, not a number.** `numeric(12,2)` does not survive a
   round trip through an IEEE-754 double, and silently wrong money is worse than
   inconvenient money.
9. **Timestamps are ISO 8601 UTC.**

### About who is asking

10. **Identity comes from a JWT this service verifies itself** (HS256, `sub` and
    `role`). No login endpoint — the brief asks who may read a history, not how
    credentials are exchanged. `npm run token -- 2` mints one for trying it out.
11. **"Admin" is global.** Any admin may read any user. There is no tenant,
    organisation, or region boundary.
12. **`403`, not `404`, for another user's orders** — and deliberately *before* any
    existence check. See the security note in question 3's neighbourhood below.

### ⚠️ The one I am least confident about

**Assumption 5, specifically that the client only ever needs next/previous — never
"jump to page 12" or "go to the oldest order."**

Keyset pagination cannot do random access. That is not a limitation I can paper
over later: it is baked into the response contract, because the only handle I hand
back is an opaque cursor. If the consumer turns out to be an admin back-office with
a numbered pager — which is exactly the kind of tool an "admin can view any user"
requirement hints at — then this API cannot serve it, and the fix is a second
strategy, not a tweak.

I accepted the bet because order history is overwhelmingly a scroll, and because
the correctness argument for keyset (below) is independent of the performance one.
But it is a bet on a consumer I never saw, and it is the first question I would ask
if I could ask one.

**A close second, on a different axis:** assumption 11, global admin. I am fairly
*confident* it matches the brief — but it has by far the worst blast radius if
wrong. In a multi-tenant system, "any admin may read any user" is a data breach
rather than a bug, and the fix is one clause in `assertMayViewOrders`.

---

## 2. What did you use AI for, and where did you override it?

Claude Opus 5 in Claude Code, throughout. The full running log is in
[`notes/ai-log.md`](notes/ai-log.md), written as the work happened. The five that
mattered:

### It proposed a `DESC` index it could not justify

First draft: `CREATE INDEX ... (user_id, created_at DESC, id DESC)`.

Postgres scans a B-tree in either direction, so an ascending index already
satisfies `ORDER BY created_at DESC, id DESC`. Explicit `DESC` columns only earn
their place on *mixed*-direction sorts like `created_at DESC, id ASC`. Asked to
justify it, the model agreed it was unnecessary — meaning it had produced a
plausible-looking index by pattern rather than by reasoning.

Changed to `(user_id, created_at, id)`. The plan confirms it:
`Index Scan Backward using idx_orders_user_id_created_at_id`.

### Its first cursor would have paginated forever

The model encoded the cursor from the JS `Date` node-postgres returns. Postgres
`timestamptz` stores microseconds; a JS `Date` holds milliseconds. Encoding
`...T00:00:00.123456Z` as `...123Z` produces a predicate that fails to exclude the
row it was built from, so the last row of every page repeats — an infinite scroll
that looks like success from the outside.

Fixed by rendering the timestamp to ISO text in SQL so the cursor is byte-exact
with what the database stored.

### It agreed to Redis; I killed it

A cache here hides query cost rather than fixing it — p50 looks healthy while the
cold path stays broken — and buys an invalidation problem (when does a new order
appear in history?) to solve a problem that does not exist at this size. I fixed
the query instead. First page p50 is 2.67 ms; there is nothing for a cache to
improve.

### I asked for a rate limiter; it talked me out of it, and it was right

I wanted `express-rate-limit`. The model pointed out the default memory store gives
each process its own counter, so a limit of N becomes N × instances — the component
is simply wrong under horizontal scaling. My fallback was "ship it and document the
flaw"; it pushed back on that too, and I agree: shipping something you have already
established is broken, with a footnote, is worse than leaving it at the edge.
Recording this one because it went against me.

### The one neither of us caught — the benchmark did

This is the one I would most want to talk about.

The timestamp fix above was written as `to_json(created_at) #>> '{}' AS created_at`.
Both of us were satisfied. **All 17 tests passed.** Then `EXPLAIN` said:

```
Sort Key: ((to_json(created_at) #>> '{}'::text[])) DESC, id DESC
->  Parallel Seq Scan on orders
```

Sequential scan. **The index had never been used, by any query, since the first
commit.**

Postgres resolves a bare identifier in `ORDER BY` against the SELECT output names
*before* the table columns. Aliasing the expression as `created_at` meant
`ORDER BY created_at DESC` sorted by the rendered text — an expression no index
covers.

The tests missed it because ISO 8601 text sorts lexicographically in the same order
as the timestamps it encodes. **The results were correct. Only the plan was wrong,
and no assertion looks at the plan.**

Renaming the alias to `created_at_iso` took the same query from **347 ms to
0.13 ms**.

The lesson: the tests and the model agreed with each other and were both wrong.
Measuring was the only step in the process that could have caught it — which is why
`npm run bench` exists rather than a sentence asserting the index "should" be used.

---

## 3. What breaks first at 100× this data?

At 100× — 500k users, 5M orders — **the query itself does not break.** That is what
the index buys, and the benchmark shows the mechanism:

| at depth 10,000 | rows read | execution |
| --- | --- | --- |
| keyset | 20 | 0.13 ms |
| `OFFSET 10000` | 10,020 | 25.62 ms |
| keyset, index dropped | 190,036 (seq scan) | 346.43 ms |

Keyset reads exactly `limit` rows at any depth, so page 1 and page 50,000 cost the
same. Row count does not change that.

### The specific failure: the working set stops fitting in `shared_buffers`, and the endpoint becomes I/O-bound

Every measurement above says `Buffers: shared hit=23` — **23 cache hits, zero
disk reads.** At 50k orders the entire table and index live in memory. That is
precisely what my own benchmark fails to prove anything about at scale.

At 5M orders across 500k users, a request for an arbitrary user is a cold B-tree
descent plus a heap fetch: roughly four to six random page reads that are no longer
in cache. On SSD that is ~0.1–1 ms each instead of nanoseconds. The same query, the
same plan, the same 20 rows — and p50 moves from 2.7 ms to tens of milliseconds,
with variance that tracks the buffer cache hit ratio rather than anything in the
code.

**The second-order failure is the one that pages someone at 3am.** Slower queries
hold pool connections longer. The pool is 10. Once average query time and
concurrency multiply past that, requests queue for a connection, and the timeouts
appear on *unrelated* endpoints sharing the pool. The dashboard blames the wrong
service, because the endpoint that actually degraded is still returning 200s.

### Why p50 monitoring would not catch it, and what would

5M orders over 500k users averages 10 per user, so most requests stay cheap and the
mean barely moves. My own skew test makes the point: with one 200k-order account in
the data, ordinary users still sit at **p50 2.67 ms / p99 3.47 ms** — the outlier is
invisible in the aggregate.

Detection, in the order I would actually reach for it:

1. **A capacity metric, not a latency metric — this is the "before a customer
   reports it" answer.** Track `pg_relation_size('orders')` plus index size against
   `shared_buffers`. When the hot index approaches the buffer pool, the cliff is
   *coming*; that is a graph you can act on weeks early, whereas latency only tells
   you it has already arrived.
2. **Cache hit ratio per query** from `pg_stat_statements` —
   `shared_blks_read / (shared_blks_read + shared_blks_hit)`. Alert below ~99%. This
   is the direct measurement of the failure described above.
3. **p99 per route, never the mean.** The mean is structurally blind to skew.
4. **Pool acquisition wait time,** exported from the app. This is the leading
   indicator of the second-order failure, and it is the number that distinguishes
   "the database is slow" from "we ran out of connections."
5. Slow query log at 100 ms.

### What I would do about it

Nothing yet — but the shape is known. The orders table partitions cleanly by
`created_at` range, and order history is overwhelmingly recent-biased, so
partitioning keeps the hot partition's index small enough to stay resident while
cold partitions age out. I did not build it, because at 50k rows it would be
speculative infrastructure and it is reversible later. See question 4.

### One thing that is not a scale problem, because of where a line sits

`getOrderHistory` authorises **before** it touches the database. A non-admin asking
about any other user gets `403` whether or not that user exists, so the endpoint
leaks nothing about which ids are real. Checking existence first and returning
`404` for unknown ids — the obvious ordering — turns it into a user-enumeration
oracle for anyone holding any valid token. Same lines of code, opposite security
property, decided entirely by order. `tests/authorization.test.ts` pins it.

The existence check that distinguishes "no orders" from "no such user" runs **only
when the page comes back empty**, since a non-empty result already proves the user
exists. The extra query never touches the hot path.

---

## 4. What did you deliberately not build?

Each of these has a trigger that would make me build it.

**A total count.** `SELECT count(*)` for the 200k-order account measures **37.66 ms**
against **3.72 ms** for the page itself — ten times the cost of the thing the user
asked for, on every page request. *Trigger:* product needs "showing 20 of 1,340";
I would serve it from an approximate count or a maintained counter, not the read
path.

**Rate limiting.** In-process limiting is incorrect under horizontal scaling; it
belongs at the gateway. Shipping a component I have already established is wrong,
with a footnote, is worse than omitting it. *Trigger:* no gateway in front of the
service.

**Redis or any cache.** Covered above — nothing to improve at 2.67 ms. *Trigger:*
the buffer-cache failure in question 3 actually arrives and partitioning is not
enough.

**Table partitioning.** The known remedy for the 100× failure, deliberately not
pre-built. *Trigger:* the capacity graph in question 3 shows the index approaching
`shared_buffers`.

**Order line items.** Either an N+1 or a join that multiplies rows and forces
in-memory grouping. The brief says "orders," and a list view rarely needs contents.
*Trigger:* the client would otherwise call the detail endpoint once per row.

**An ORM.** Prisma's `cursor` helper only works on a unique column; a composite
`(created_at, id)` cursor has to be written as an `OR` expansion that plans worse
than the row-value comparison. I would have dropped to `$queryRaw` for the one
query that matters and carried the ORM for nothing.

**A login endpoint, refresh tokens, key rotation.** The brief asks who may read a
history, not how credentials are exchanged. Verification is one function; the swap
from HS256 to JWKS lives entirely inside `src/auth/jwt.ts`.

**Filtering and sorting by status or date range.** Not requested, and each one
changes which index is optimal — building them speculatively risks designing the
wrong index for the query that actually shows up.

**Structured logging, tracing, metrics export.** Question 3 names the metrics that
matter; wiring an exporter is real work with no requirement behind it yet. This is
the omission I am least comfortable with, since I spent question 3 arguing for
observability I did not build.

**Dockerising the app, CI, an OpenAPI spec, a migration framework.** Postgres is in
Docker because setup must work in five minutes; the app is not, because it adds a
rebuild loop for a reviewer who runs it once. One schema file, applied whole, beats
a migration tool for a schema that is recreated from scratch.

**More tests.** Seventeen, each pinning a decision — the status-code table, the
ordering including the tiebreaker, cursor continuity with no overlap or gap,
malformed input. I did not add coverage padding. Given the alias bug, I would
rather have one assertion on the query plan than ten more on response bodies.

---

## Pre-answers for the call

**Why this structure rather than the obvious alternative?**
For one endpoint this could be a single file, and I nearly wrote it that way. The
service layer exists for one present-tense reason: `assertMayViewOrders` is the
highest-risk logic here, and it deserves a test with no HTTP and no database in the
way — `tests/authorization.test.ts` is that test. I rejected the model's original
justification ("it will apply to future endpoints") as speculative.

**What happens on this line if the input is empty?**
Empty page → `data: []`, `next_cursor: null`, and *only then* an existence check, so
a real user with no orders gets `200` and a missing user gets `404`. Empty
`Authorization` header → `401` before any query. Empty `cursor=` → rejected by
`z.string().min(1)` as `400`, never silently treated as page 1 — that would turn a
client bug into an endless pagination loop.

**The requirement just changed to include pagination — where does that go?**
It is already here, which is my answer to requirement 2. If it had not been:
`repository.ts` for the predicate, `cursor.ts` for encode/decode, `controller.ts`
for the `limit`/`cursor` schema. The service would not change — it neither knows nor
cares how a page is bounded.

**If you had to cut this in half, what goes?**
The service collapses into the controller and `cursor.ts` inlines into the
repository — three files, same behaviour, one fewer test. What stays: the index, the
keyset predicate, the authorise-before-existence ordering, and `bench.ts`. The
benchmark is the last thing I would cut, because it is the only part of this
submission that found a bug the tests could not see.

---

## Known limitations

- **The schema is mine, not yours.** If the real one differs on nullability of
  `created_at` or on id type, the cursor needs revisiting first.
- **Load was never tested.** Everything here is single-query cost. The pool
  exhaustion described in question 3 is reasoned, not measured — the honest
  distinction between that section and the rest of the numbers.
- **Benchmarks are from one laptop** with everything in cache. The ratios hold; the
  absolute numbers will not.
- One moderate dev-only advisory remains in `@vitest/mocker`. Production
  dependencies audit clean.
