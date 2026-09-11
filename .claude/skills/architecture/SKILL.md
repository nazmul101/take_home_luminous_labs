---
name: architecture
description: Architecture rules and locked decisions for the order-history service. Load before creating files, choosing a library, writing SQL, adding a layer, naming a file, or deciding a status code. Also load when asked "where does X go?" or when tempted to add a dependency, a cache, an ORM, or a new layer.
---

# Architecture — order history service

Take-home assignment. The graded endpoint is `GET /api/users/:id/orders`.
`POST /api/auth/login` exists only so the Postman collection is self-contained.

`DECISIONS.md` is 60% of the grade and is read before the code.
Every line must be defensible out loud in a 20-minute screen-shared call.

## Locked decisions — do not revisit without asking

| Decision | Rule |
|---|---|
| Data access | Raw `pg`. **No ORM.** No Prisma, no Knex, no TypeORM. |
| Caching | **No Redis.** No in-process cache. |
| Pagination | **Keyset (cursor).** Never `OFFSET`. |
| Total count | **Not on the hot path.** No `COUNT(*)` in the paged query. |
| Rate limiting | **Not in the app.** Edge concern. |
| Login | **Exactly one** `POST /api/auth/login`. Never a per-role login route. |
| Passwords | **Plaintext, by explicit instruction.** See below — it must be documented, not hidden. |
| Products | **No products table.** `orders.product_id` is a bare integer. |
| Postgres | Docker. The app is **not** dockerized. |

If a change would break one of these rows, stop and ask.

## Project structure

Modelled on the reference repo `nazmul5297/jwt_node_express_postgres`: modules own
nested plural subfolders, each module exposes `init(app)`, files are named
`<name>.<type>.ts`.

```
src/
  server.ts                     process lifecycle
  app.ts                        express wiring; calls each module's init(app)

  configs/
    app.config.ts               env, validated at import, exported as `appConf`
    db.config.ts                pool, exported as `db` with .query/.connect/.close

  entities/
    schema.sql                  roles, users, orders + the one index

  errors/
    custom.error.ts             abstract CustomError: statusCode, code, serializeErrors()
    bad-request.error.ts        400
    unauthorized.error.ts       401 (+ InvalidCredentialsError)
    forbidden.error.ts          403
    not-found.error.ts          404
    validation.error.ts         400, serializes Zod issues to {message, field}[]

  middlewares/
    error-handler.middle.ts     the single error -> response mapping
    wrap.middle.ts              chain composer + async capture
    auth.middle.ts              authorization() factory -> req.user

  utils/
    response.ts                 sendSuccess envelope

  modules/
    auth/
      index.ts                  init(app) -> mounts at /api/auth
      routes/auth.route.ts
      services/auth.service.ts
      repositories/auth.repository.ts
      validators/auth.validator.ts
      utils/jwt.ts
    orders/
      index.ts                  init(app) -> mounts at /api
      routes/orders.route.ts
      services/orders.service.ts
      repositories/orders.repository.ts
      validators/orders.validator.ts
      utils/cursor.ts

  scripts/                      migrate, seed, seed-skew, bench
```

### Naming — no exceptions

`<name>.<type>.ts`, matching the reference: `orders.route.ts`, `orders.service.ts`,
`orders.repository.ts`, `orders.validator.ts`, `auth.middle.ts`, `custom.error.ts`,
`app.config.ts`. Module names are plural where the folder is plural. Never mix
`order.service.ts` with `orders.repository.ts`.

### Layer responsibilities

- **index.ts** — `init(app)` and the mount path. Nothing else.
- **route** — path, middleware chain via `wrap`, parse with the validator, call the
  service, send the envelope.
- **service** — authorization and orchestration. The only place the self-or-admin rule
  lives. **Throws** `CustomError` subclasses; never returns an `Error` as a value.
- **repository** — SQL only. No HTTP, no status codes, no knowledge of the caller.
- **validator** — Zod schemas. Exported, not inlined into the route.

The reference puts SQL directly in services and has no repository layer; adding one is
a deliberate departure, because the SQL is the thing under test.

### Four things the reference repo does that this one must NOT copy

Each was a real defect there and would have to be defended line by line:

1. `app.use(errorHandler)` registered **before** the routes — Express matches in
   registration order, so it never fires. Ours is registered last.
2. `signOn` runs the same `COUNT` query **twice** in one expression, then a third
   `SELECT`. Ours is one query; the row's absence is the same answer.
3. Hardcoded JWT secret `"APP"`, duplicated in two functions. Ours is env-validated.
4. `return new Error(...)` then `if (x instanceof Error)` at the call site. A forgotten
   check is a silent auth bypass — ours throws.

Also: the reference wraps synchronous `jwt.sign`/`jwt.verify` in Promises. Ours calls
them synchronously, because they are synchronous without a callback.

## Middleware

`wrap(...handlers)` composes a chain and captures async rejections into `next`.
Used at the route:

```ts
router.get('/users/:id/orders', wrap(authorization(), async (req, res) => { ... }));
```

`authorization()` is a **factory** returning the middleware, matching the reference
repo's `authorization()` pattern — the call site reads as a declaration, and options
can be added later without touching every route. It sets `req.user`.

A handler that throws or rejects short-circuits the rest of the chain and lands in
the global error handler. Express 5 already forwards async rejections; `wrap` exists
so the chain is declared in one place at the route and so one handler failing
provably prevents the next from running.

## Response envelope

Success — set by `utils/response.ts`, never hand-rolled in a controller:

```json
{
  "success": true,
  "message": "Orders retrieved",
  "data": [],
  "meta": { "next_cursor": null }
}
```

- `data` is always the payload itself — an array for collections, an object for one thing.
- `meta` carries pagination only. Omitted when there is none.
- **No `statusCode` in the body.** It duplicates the HTTP status, and if the two ever
  disagree the client has to pick a winner.

Failure — set by `error-handler.middle.ts`, built from the thrown error's
`serializeErrors()`:

```json
{
  "success": false,
  "message": "Request validation error",
  "errors": [{ "message": "User id must be a positive integer", "field": "id" }],
  "code": "validation_error"
}
```

Errors are a `CustomError` subclass that owns its own `statusCode` and `code`, following
the reference repo's error hierarchy. `statusCode` is abstract rather than a constructor
argument, so a caller cannot throw a `NotFoundError` carrying a 200.

Anything that is not a `CustomError` is a bug: log it in full, return an opaque 500.
Never let a Postgres error string reach the client — it describes the schema.

## Database

Three tables. `roles`, `users`, `orders`.

- `roles` — id, name, created_at, updated_at.
- `users` — id, name, email, password, role_id → roles, created_at, updated_at.
- `orders` — id, product_id, user_id → users, quantity, unit_price, total_price, status, created_at, updated_at.

Rules:

- **`role_id` is a foreign key**, and the role name is resolved **once at login** and
  carried in the JWT. Never join `roles` on the order-history path — that request
  already knows the caller's role from the token.
- **No products table.** `product_id` is a plain integer with no foreign key: a
  denormalized reference to a product service that is out of scope. Say it that way —
  an unexplained dangling id is a schema smell, a documented cross-service reference
  is a pattern.
- **`total_price` is stored, not derived.** An order is a historical record; the price
  at purchase time must not move when a product's price changes later. Do not add a
  `CHECK (total_price = quantity * unit_price)` — it forbids discounts.
- **Money is `numeric`, never float**, and reaches JSON as a string. `numeric(12,2)`
  does not survive an IEEE-754 round trip.
- **`updated_at` is maintained by a trigger**, not by application code. A column the
  app forgets to set is worse than no column, and a reviewer will check.

### Passwords are plaintext — by explicit instruction

This was decided deliberately, not overlooked. It **must** appear prominently in the
deliberate-omissions section of `DECISIONS.md` with its reasoning, because the
submission's strongest security argument (403-before-existence, below) sits in the
same repository and the two look contradictory otherwise.

Do not quietly add hashing. Do not quietly leave it undocumented.

### The index

```sql
CREATE INDEX idx_orders_user_id_created_at_id ON orders (user_id, created_at, id);
```

**No `DESC` in the definition — be ready to say why.** Postgres scans a B-tree in
either direction, so an ascending index satisfies `ORDER BY created_at DESC, id DESC`
by walking backward. Explicit `DESC` columns only earn their place on
*mixed*-direction sorts such as `created_at DESC, id ASC`. The measured plan says
`Index Scan Backward using idx_orders_user_id_created_at_id`, which is the proof.

No index on `product_id`. Nothing queries by product.

## The query

```sql
SELECT id, product_id, quantity, unit_price, total_price, status,
       to_json(created_at) #>> '{}' AS created_at_iso
FROM orders
WHERE user_id = $1
  AND (created_at, id) < ($3::timestamptz, $4::bigint)   -- omitted on first page
ORDER BY created_at DESC, id DESC
LIMIT $2;
```

Non-negotiable details:

- **Alias the rendered timestamp `created_at_iso`, never `created_at`.** Postgres
  resolves a bare identifier in `ORDER BY` against SELECT output names *before* table
  columns. Aliasing it `created_at` makes `ORDER BY created_at DESC` sort the rendered
  **text** — an expression no index covers — turning every page into a sequential scan
  and a sort. This actually happened here. All tests still passed, because ISO 8601
  text sorts in the same order as the timestamps it encodes. Only `EXPLAIN` caught it.
  347 ms → 0.13 ms.
- **Render the timestamp to ISO text in SQL.** Postgres `timestamptz` holds
  microseconds; a JS `Date` holds milliseconds. A cursor round-tripped through a
  `Date` fails to exclude the row it was built from, so the last row of each page
  repeats forever.
- **Row-value comparison** `(created_at, id) < ($3, $4)`, not an `OR` expansion. The
  row-value form is one range condition the planner turns into a single index scan.
- **`id` is in the sort key as a tiebreaker.** Ties on `created_at` are ordinary in
  bulk imports. Without a tiebreaker the order is non-deterministic and the cursor is
  unsound. The seed creates tied timestamps deliberately so tests exercise this.
- Fetch `limit + 1` to detect a next page without a second query.
- Cursor is base64 over the created_at/id pair, opaque to the client. An undecodable
  cursor is a `400`, never a silent reset to page 1.
- `limit` defaults to 20, clamped to 100. Unbounded `limit` is a DoS vector.

### What keyset costs — state it, do not hide it

Next/previous only. **No random access, no page numbers.** That is an assumption about
a client that was never specified, it is baked into the response contract, and it
belongs in the assumptions list flagged as the least confident one.

## Authorization — order matters

**Authorize before checking whether the user exists.** The single most important
ordering in the codebase.

Get it right and a stranger receives `403` whether or not the target exists — nothing
leaks. Get it backwards and this is a user-enumeration oracle for any holder of a
valid token.

| Case | Response |
|---|---|
| Missing, invalid, or expired token | `401` |
| Valid token, `:id` is another user, caller not admin | `403` |
| Self or admin, user exists, no orders | `200`, empty `data`, null cursor |
| Self or admin (admin in practice), user does not exist | `404` |
| Bad `:id`, bad `limit`, undecodable cursor | `400` |
| Login with unknown email or wrong password | `401`, identical message for both |

The existence check runs **only when the page comes back empty** — a non-empty result
already proves the user exists, so it never touches the hot path.

Login must return the same `401` and the same message for "no such email" and "wrong
password". Distinguishing them is an account-enumeration oracle, and it would
contradict the care taken on the orders path.

## Stack

Runtime: `express`, `pg`, `zod`, `jsonwebtoken`
Dev: `vitest`, `supertest`, `tsx`, `typescript`

Pinned: `vitest` 3.x (npm 10's resolver crashes on vitest 4's optional peer graph),
`express` 5.x (clears the `qs` advisory).

## Tests

Integration against real Postgres, not mocks — what is under test *is* the SQL.

One test per row of the status-code table, plus ordering-with-tiebreaker, cursor
continuity with no overlap and no gap, and login success/failure. The authorization
rule additionally gets a unit test with no HTTP and no database — that is the stated
reason the service layer exists, so it must be demonstrated.

Each test pins a judgement call. Do not pad for coverage.

## Postman collection

`postman/` — importable, with a collection variable for `baseUrl` and a test script on
login that stores the token into a variable the orders requests use. A reviewer must be
able to import, click Login, click Orders, and see data without editing anything.

Credentials go in the README. This is the reason the login endpoint exists at all.

## Scope guards

Deliberately not built — this list answers a graded question:
password hashing (explicit instruction — document it loudly), Redis, total count on
the read path, ORM, in-app rate limiting, products table, refresh tokens, logout,
registration, order line items, OpenAPI spec, tracing, filtering by status or date
range, app Dockerization, CI, soft deletes.

Rules of engagement:

- **Do not add a dependency** without asking.
- **Do not add a layer, an abstraction, or a folder** the current requirements do not force.
- Prefer deleting code over adding it.
- Under-building is the correct failure mode. The brief calls 2-3 hours a ceiling.

## Evidence requirement

Claims must be measured, not asserted:

- `EXPLAIN (ANALYZE, BUFFERS)` for keyset vs `OFFSET` at depth — timings and rows read.
- The same query with the index dropped.
- p50 across ordinary users against a skewed account.

**Any schema change invalidates every number in `DECISIONS.md`.** Re-run `npm run bench`
and re-sync the figures — "consistent with what you claimed" is a grading criterion.

### Seeding without breaking the five-minute setup

- Set-based `generate_series` inserts, never a loop of round trips.
- The whale account (~200k orders) stays out of the default seed, behind
  `npm run seed:skew`.

## Running log — keep current as work proceeds

- `notes/ai-log.md` — every model override, with reasoning. Include cases where the
  model was right and the human reverted; that is calibration, and it is the one
  answer that cannot be fabricated.
- `notes/benchmarks.md` — raw plans and timings, pasted unedited.

Write both **as work happens**, never reconstructed at the end.
