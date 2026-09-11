# Order history API

`GET /api/users/:id/orders` — a user's orders, newest first, keyset-paginated, readable
only by that user or an admin.

**Read [`DECISIONS.md`](DECISIONS.md) first.** It is the actual submission; this file
just gets it running.

## Setup

Requires Node 20+ and Docker.

```bash
cp .env.example .env
docker compose up -d      # Postgres 16 on port 5433
npm install
npm run setup             # schema + ~5k users, ~50k orders  (~10s)
npm run dev               # http://localhost:3000
```

Port 5433, not 5432, so the container does not collide with a local Postgres.

## Test accounts

Seeded by `npm run setup`. **Passwords are stored in plaintext** — deliberately, for
this exercise only; see the deliberate-omissions section of `DECISIONS.md`.

| email | password | role | notes |
| --- | --- | --- | --- |
| `admin@example.com` | `password123` | admin | may read any user |
| `user@example.com` | `password123` | user | user id 2, has orders |
| `empty@example.com` | `password123` | user | user id 3, has no orders |

## Postman

Import [`postman/order-history.postman_collection.json`](postman/order-history.postman_collection.json).

Click **Login as user**, then anything under **Orders** — the login test script stores
the token in a collection variable, so nothing is copied by hand. Page 1 saves its
cursor for page 2 the same way.

The collection also covers the failure cases, including the pair worth looking at side
by side: user `999999` returns **403** to an ordinary user and **404** to an admin, so
the endpoint never reveals which user ids exist.

## Or use curl

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"password123"}' | jq -r .data.token)

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/users/2/orders?limit=3"
```

```json
{
  "success": true,
  "message": "Orders retrieved",
  "data": [
    {
      "id": "50016",
      "product_id": 125,
      "quantity": 2,
      "unit_price": "25.00",
      "total_price": "50.00",
      "status": "paid",
      "created_at": "2026-09-11T16:26:00+00:00"
    }
  ],
  "meta": { "next_cursor": "eyJjIjoiMjAyNi0wOS0xMVQxNjoyNjowMCswMDowMCIsImkiOiI1MDAxNiJ9", "limit": 3 }
}
```

Pass `meta.next_cursor` back as `?cursor=` for the next page. `null` means last page.

## API

### `POST /api/auth/login`

Body: `{ "email": "...", "password": "..." }` → `{ token, user }`.

One login route, not one per role — the role comes from the user's row either way.
Unknown email and wrong password return the **identical** `401`; telling them apart
would be an account-enumeration oracle.

### `GET /api/users/:id/orders`

| query param | |
| --- | --- |
| `limit` | 1–100, default 20 |
| `cursor` | opaque, from a previous `meta.next_cursor` |

| status | when |
| --- | --- |
| `200` | orders, possibly an empty array |
| `400` | bad id, out-of-range limit, malformed cursor |
| `401` | missing, invalid, or expired token |
| `403` | not your orders, and you are not an admin |
| `404` | admin asked for a user that does not exist |

`403` is returned **before** any existence check, so the endpoint never reveals which
user ids are real.

## Tests

```bash
npm test        # 22 tests; needs `npm run setup` first
npm run typecheck
```

`tests/authorization.test.ts` runs with no HTTP and no database — that is the reason
the service layer exists. `tests/orders.test.ts` and `tests/auth.test.ts` run against
real Postgres, because what is under test is the SQL.

## Benchmarks

```bash
npm run seed:skew   # adds ~200k orders to user 2  (~12s)
npm run bench
```

Reproduces every number quoted in `DECISIONS.md`. Latest output:
[`notes/benchmarks.md`](notes/benchmarks.md).

The skew seed is separate on purpose — `npm run setup` stays fast for a first run.

## Layout

Structure follows `nazmul5297/jwt_node_express_postgres`: modules own nested plural
subfolders, each exposes `init(app)`, files are named `<name>.<type>.ts`.

```
src/
  app.ts                     wiring; calls each module's init(app)
  server.ts                  lifecycle
  configs/
    app.config.ts            env, validated at import
    db.config.ts             pool, exported as `db`
  entities/schema.sql        roles, users, orders + the one index
  errors/
    custom.error.ts          abstract base: statusCode, code, serializeErrors()
    bad-request | unauthorized | forbidden | not-found | validation
  middlewares/
    error-handler.middle.ts  the single error -> response mapping
    wrap.middle.ts           chain composer; a failing handler short-circuits the rest
    auth.middle.ts           authorization() factory -> req.user
  utils/response.ts          success envelope
  modules/
    auth/    index.ts | routes/ | services/ | repositories/ | validators/ | utils/
    orders/  index.ts | routes/ | services/ | repositories/ | validators/ | utils/
  scripts/                   migrate, seed, seed-skew, bench

postman/                     importable collection
notes/benchmarks.md          raw EXPLAIN output
```

A repository layer is a deliberate addition — the reference puts SQL in services, but
here the SQL is the thing under test.

## Teardown

```bash
docker compose down -v
```
