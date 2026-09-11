# Order history API

`GET /api/users/:id/orders` — a user's orders, newest first, keyset-paginated,
readable only by that user or an admin.

**Read [`DECISIONS.md`](DECISIONS.md) first.** It is the actual submission; this
file just gets it running.

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

## Try it

```bash
TOKEN=$(npm run --silent token -- 2)          # user 2 has orders
curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:3000/api/users/2/orders?limit=3"
```

```json
{
  "data": [
    {
      "id": "200036",
      "status": "paid",
      "total_amount": "35.00",
      "created_at": "2026-09-11T08:52:00+00:00"
    }
  ],
  "next_cursor": "eyJjIjoiMjAyNi0wOS0xMVQwODo1MjowMCswMDowMCIsImkiOiIyMDAwMzYifQ"
}
```

Pass `next_cursor` back as `?cursor=` for the next page. `null` means the last page.

Other identities:

```bash
npm run token -- 1 admin   # admin: may read any user
npm run token -- 3         # user 3 has no orders (the empty case)
```

### Query parameters

| | |
| --- | --- |
| `limit` | 1–100, default 20 |
| `cursor` | opaque, from a previous `next_cursor` |

### Responses

| | |
| --- | --- |
| `200` | orders, possibly an empty array |
| `400` | bad id, out-of-range limit, malformed cursor |
| `401` | missing, invalid, or expired token |
| `403` | not your orders, and you are not an admin |
| `404` | admin asked for a user that does not exist |

`403` is returned **before** any existence check, so the endpoint never reveals
which user ids are real. See `DECISIONS.md`.

## Tests

```bash
npm test        # 17 tests; needs `npm run setup` first
npm run typecheck
```

`tests/authorization.test.ts` runs with no HTTP and no database.
`tests/orders.test.ts` runs against real Postgres — what is under test is the SQL.

## Benchmarks

```bash
npm run seed:skew   # adds ~200k orders to user 2  (~15s)
npm run bench
```

Reproduces every number quoted in `DECISIONS.md`. Latest output:
[`notes/benchmarks.md`](notes/benchmarks.md).

The skew seed is separate on purpose — `npm run setup` stays fast for a first run.

## Layout

```
src/
  auth/          JWT verification, middleware, token CLI
  orders/
    controller   Zod validation, HTTP shape
    service      authorization + orchestration
    repository   SQL
    cursor       opaque cursor encode/decode
  db/            pool, migrate, seed, seed-skew, bench
  http/errors    AppError + the single error handler
db/schema.sql    tables and the one index that matters
notes/           ai-log.md, benchmarks.md
```

## Teardown

```bash
docker compose down -v
```
