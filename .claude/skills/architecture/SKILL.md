---
name: architecture
description: Architecture rules and locked decisions for the order-history endpoint. Load before creating files, choosing a library, writing SQL, adding a layer, or deciding a status code. Also load when asked "where does X go?" or when tempted to add a dependency, a cache, an ORM, or a new layer.
---

# Architecture — order history endpoint

Take-home assignment. One endpoint: `GET /api/users/:id/orders`.
Graded on judgement, not volume. `DECISIONS.md` is 60% of the grade.
Every line must be defensible out loud in a 20-minute screen-shared call.

## Locked decisions — do not revisit without asking

| Decision | Rule |
|---|---|
| Data access | Raw `pg`. **No ORM.** No Prisma, no Knex, no TypeORM. |
| Caching | **No Redis.** No in-process cache. |
| Pagination | **Keyset (cursor).** Never `OFFSET`. |
| Total count | **Not on the hot path.** No `COUNT(*)` in the paged query. |
| Rate limiting | **Not in the app.** Edge concern — see Stack. |
| Layers | Exactly three. Do not add a fourth. |
| Postgres | Docker. The app is **not** dockerized. |

If a change would break one of these rows, stop and ask.

## Layering

```
route -> controller -> service -> repository
         (validate)    (authz)    (SQL)
```

- **controller** — Zod parse of params/query. Returns 400 on bad input. No business logic.
- **service** — authorization, then orchestration. The only place the self-or-admin rule lives.
- **repository** — SQL only. No knowledge of HTTP, status codes, or the caller.

**Justification — use this one, not the other one.** The service layer exists because the authorization rule is the highest-risk logic in the codebase (see *Authorization — order matters*) and it needs a unit test that does not go through HTTP or Postgres. That is a present-tense reason.

Do **not** justify the split with "it will apply to future user-scoped endpoints." There are no future endpoints. Speculative generality is exactly what this brief punishes, and the argument is weaker than the testability one anyway.

If asked to cut it in half: the service collapses into the controller, the repository stays.

## The query

```sql
CREATE INDEX idx_orders_user_created
  ON orders (user_id, created_at, id);
```

**No `DESC` in the index definition — and be ready to say why.** Postgres scans a B-tree index in either direction, so an ascending composite index satisfies `ORDER BY created_at DESC, id DESC` by walking backward. Explicit `DESC` columns only earn their place for *mixed*-direction sorts such as `created_at DESC, id ASC`. Writing `DESC` here would be a fancier index than the query needs, with no plan difference — which reads as copied rather than understood.

```sql
SELECT id, user_id, status, total_amount, created_at
FROM orders
WHERE user_id = $1
  AND (created_at, id) < ($2, $3)   -- omitted on first page
ORDER BY created_at DESC, id DESC
LIMIT $4;
```

Non-negotiable details:

- **Row-value comparison** `(created_at, id) < ($2, $3)`, not an `OR` expansion. The row-value form walks the composite index directly; the `OR` form can plan as a BitmapOr and read more rows than it should.
- **`id` is in the sort key as a tiebreaker.** Ties on `created_at` are real in seed data and bulk imports. Without `id` the ordering is non-deterministic, which makes the cursor unsound — pages can repeat or skip rows.
- Fetch `limit + 1` rows to know whether a next page exists without a second query.
- Cursor is base64 over the `created_at` and `id` pair — opaque to the client. An undecodable cursor is a 400, never a silent reset to page 1.
- `limit` defaults to 20, clamped to a max of 100. An unbounded `limit` is a denial-of-service vector.

### BLOCKING: verify created_at is NOT NULL before writing this query

If `created_at` is nullable, the row comparison evaluates to `NULL` for any row with a null timestamp, the row fails the `WHERE`, and **that order silently disappears from the user's history**. No error, no log line. Silent data loss is the worst failure mode in this design.

Check the schema first. Then either:

- confirm `NOT NULL` and state it in `DECISIONS.md` as a verified precondition, or
- handle nulls explicitly and justify the ordering semantics chosen for them.

Do not write the cursor predicate until this is resolved.

### Why keyset over OFFSET — two independent reasons, give both

1. `OFFSET 100000` reads and discards 100,000 rows. Keyset reads exactly `limit`, so page 1 and page 5,000 cost the same.
2. Correctness. Offset pagination over a newest-first list **duplicates and skips rows** when new rows arrive mid-scroll. On order history, new orders arriving at the top is the normal case, not an edge case.

### What keyset costs — state this, do not hide it

Keyset gives next and previous only. **No random access, no page numbers, no jump-to-oldest.** That is an assumption about the client, and the client was never specified. It belongs in the assumptions list in `DECISIONS.md` and is a strong candidate for the *least confident* flag.

The reasoning for accepting the tradeoff: order history is a scroll, not a numbered table. But it is a bet on an unseen consumer, and it is baked into the response contract — so name it rather than letting a reviewer find it.

## Authorization — order matters

**Authorize before checking whether the user exists.** This is the single most important ordering in the codebase.

Get it right and a stranger receives `403` whether or not the target user exists — the endpoint leaks nothing. Get it backwards and you have built a user-enumeration oracle for anyone holding a valid token. Same lines of code, opposite security properties.

| Case | Response |
|---|---|
| Missing, invalid, or expired token | `401` |
| Valid token, `:id` is another user, caller not admin | `403` |
| Self or admin, user exists, no orders | `200` with an empty `data` array and a null cursor |
| Self or admin (admin in practice), user does not exist | `404` |
| Bad `:id`, bad `limit`, undecodable cursor | `400` |

The existence check runs **only when the orders result is empty**. A non-empty result already proves the user exists, so the extra `SELECT 1 FROM users` never touches the hot path.

Known edge case to decide and record: a valid token whose subject no longer exists (deleted account). The table above yields `404`; an argument exists for `401`, since the token references a principal that is gone. Pick one and write down why.

Identity comes from a verified JWT carrying subject and role claims, HS256, secret from env. Production swaps this for asymmetric verification against a JWKS endpoint — that change is confined to one function, and say so.

## Response shape

Two fields only: a `data` array and a `next_cursor` that is a base64 string or null. No `total`. No `page`. No envelope beyond this.

On counts: the objection is to a `COUNT(*)` **per page request**, not to counts existing. A product that needs "showing 20 of 1,340" should get it from an approximate count, a maintained counter column, or a separate endpoint — not from the paged read path. Phrase it that way; a blanket "counts are forbidden" is dogma and invites the obvious rebuttal.

## Stack

Runtime: `express`, `pg`, `zod`, `jsonwebtoken`
Dev: `vitest`, `supertest`, `tsx`, `typescript`

**No `express-rate-limit`.** In-process rate limiting with a memory store gives each process its own counter, so a limit of N becomes N times the instance count — it is incorrect the moment the service scales horizontally. Shipping a component already known to be wrong, with a footnote admitting it, is a worse story than not shipping it. Rate limiting belongs at the gateway. This goes in the deliberate-omissions list with that reasoning.

## Tests

Integration against real Postgres, not mocks — what is under test *is* the SQL and the ordering.

One test per row of the status-code table, plus:

- newest-first ordering actually asserted
- page 2 continues from page 1 with no overlap and no gap

Six to eight tests total. Each one pins a judgement call. Do not pad for coverage.

The authorization rule additionally gets a unit test with no HTTP and no database — that is the stated reason the service layer exists, so it must be demonstrated.

## Scope guards

Deliberately not built — keep this list, it answers a graded question:
Redis, total count on the read path, ORM, in-app rate limiting, order line items, OpenAPI spec, tracing, filtering by status or date range, app Dockerization, CI, refresh tokens, soft-delete handling.

Rules of engagement:

- **Do not add a dependency** without asking.
- **Do not add a layer, an abstraction, or a config file** that the current requirements do not force.
- Prefer deleting code over adding it.
- Under-building is the correct failure mode here. The brief says 2-3 hours is a ceiling and to stop early if done.

## Evidence requirement

Claims must be measured, not asserted. Before writing the relevant section of `DECISIONS.md`:

- `EXPLAIN (ANALYZE, BUFFERS)` for keyset versus `OFFSET` at depth — record both timings and rows read.
- The same query with the index dropped — record the sequential scan and timing, then restore the index.
- Show that p50 across normal users stays flat while a skewed account degrades. This turns the 100x question from a prediction into a measurement.

### Seeding the skew without breaking the five-minute setup

The whale account (roughly 200k orders) must **not** be in the default seed. Naive row-by-row inserts at that volume fight the setup budget directly.

- Generate it in a single statement with `generate_series`, not a loop — seconds, not minutes.
- Put it behind a separate `npm run seed:skew`, so `npm run seed` stays fast for a reviewer who just wants the service running.

### Budget reality

The full specified scope — app, JWT, Zod, docker-compose, seed, skew seed, six to eight integration tests, benchmark runs, two notes files, DECISIONS.md, README, clean-clone verification — does not fit in 2-3 hours.

If something must be cut, **keep the benchmarks and trim the test count**. Tests seven and eight are replaceable; a pasted query plan is the differentiator, because a model can write the argument but cannot run the database.

## Running log — keep these current as work proceeds

- `notes/ai-log.md` — every point where the human overrode the model, with the reasoning. Include cases where the model was right and the human reverted; that is calibration, and it is the one answer that cannot be fabricated.
- `notes/benchmarks.md` — raw query plans and timings, pasted unedited.

Write both **as work happens**, never reconstructed at the end.
