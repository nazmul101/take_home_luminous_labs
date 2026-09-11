# DECISIONS

`GET /api/users/:id/orders` — a user's orders, newest first, paginated, readable only
by that user or an admin.

There is also `POST /api/auth/login`. It exists so the Postman collection works on its
own, nothing more.

**I stopped at about 3 hours.** The brief called that a ceiling, so I stopped rather
than kept polishing. What I left out is in section 4.

All the numbers below come from `npm run bench`. Raw query plans are in
[`notes/benchmarks.md`](notes/benchmarks.md).

---

## 1. What the requirements didn't tell me

The brief was four sentences. Everything here is a decision I had to make myself.

### The schema wasn't actually attached

The brief says a schema and seed script are provided, but nothing came with it. So I
wrote both. That means the whole schema is an assumption. Three parts of it change how
the code works:

**Integer ids, not UUIDs.** This affects how I validate `:id` and how the cursor is
built. With UUIDs the ids aren't sequential, so "newest" would depend entirely on the
timestamp.

**`orders.created_at` is `NOT NULL`.** This matters more than it looks. The pagination
query filters on `(created_at, id) < (...)`. If `created_at` were null, that comparison
returns null, the row fails the filter, and the order just disappears from the user's
history. No error, nothing in the logs. I made the column `NOT NULL` instead of writing
code around it.

**Roles are a separate table.** `users.role_id` points at `roles`. The join costs one
query at login, and then the role travels in the JWT — so the orders endpoint never
touches the `roles` table at all.

A few other schema choices:

- **No products table.** `orders.product_id` is just an integer with no foreign key. I'm
  treating it as a reference to a product service that's out of scope. Nothing here looks
  up orders by product, so there's no index on it either.
- **`total_price` is stored, not calculated.** An order is a record of what happened. If
  a product's price changes next month, the old order's total shouldn't move. I also
  didn't add a constraint forcing `total_price = quantity × unit_price`, because that
  would make discounts impossible.
- **`updated_at` is set by a database trigger.** If the application has to remember to
  update it, sooner or later it won't.

I also assumed there are no soft deletes, and that "newest" means `created_at` rather
than some other date. In a real order system that's genuinely ambiguous and I'd ask.

### API decisions

- **"Newest first" means `created_at DESC, id DESC`.** The `id` is there to break ties.
  Two orders created in the same second are normal, and without a tiebreaker the order
  isn't stable — which breaks pagination. The seed data deliberately includes tied
  timestamps so the tests actually hit this case.
- **Pagination exists at all.** The brief says "must stay responsive as the number of
  orders grows" without saying how. I used a cursor.
- **No orders is `200` with an empty list, not `404`.** "You haven't ordered anything" is
  a valid answer, not an error.
- **An order is just its header** — product, quantity, prices, status, date. No line
  items.
- **Money is a string in JSON.** `numeric(12,2)` doesn't survive being turned into a
  JavaScript number. Wrong money is worse than awkward money.
- **Response shape is `{ success, message, data, meta }`.** Pagination goes in `meta` so
  `data` stays a plain array.

### Who's asking

- **Identity comes from a JWT** this service issues and checks. One login route, not one
  per role — the role comes from the user's row either way.
- **Admin is global.** Any admin can read any user. No teams, tenants, or regions.
- **`403` for someone else's orders, not `404`** — and the check happens before I look at
  the database. More on this in section 3.
- **Login gives the same error for a wrong email and a wrong password.** If they differ,
  someone can find out which emails are registered just by trying them.

### The assumption I'm least sure about

**That the client only needs next and previous, never "go to page 12."**

Cursor pagination can't jump to an arbitrary page. And I can't quietly add it later,
because the API only hands back an opaque cursor — that's baked into the response now. If
the real consumer is an admin back-office with numbered pages, this doesn't work for
them, and fixing it means a second approach, not a small change.

I took the bet because order history is usually something you scroll. But I never saw the
client, and this is the first thing I'd ask about.

**Second on the list:** admin being global. I'm fairly confident that's what the brief
means. But if it's wrong in a multi-tenant system, it's a data breach rather than a bug.
The fix is one line in `assertMayViewOrders`.

---

## 2. What I used AI for, and where I overrode it

I used Claude for most of the code. I kept a note of every point where we disagreed.
The five that mattered:

**1. It wrote an index with `DESC` in it, and couldn't say why.**
Its version was `(user_id, created_at DESC, id DESC)`. Postgres can read an index
backwards, so plain `(user_id, created_at, id)` does the same job. I asked why the
`DESC` was there and it agreed it wasn't needed. So it had copied a pattern instead of
thinking. I removed it — and the query plan now literally says `Index Scan Backward`,
which proves the point.

**2. Its first cursor would have repeated the same rows forever.**
It built the cursor from a JavaScript date. Postgres stores more decimal places than
JavaScript keeps, so the cursor came out slightly too early — meaning the last row of
each page came back again on the next page, forever. I fixed it by formatting the date
in SQL instead, so the cursor matches the database exactly.

**3. It was happy to add Redis. I said no.**
A cache would hide how slow the query is instead of making it fast. And it creates a new
problem: when someone places an order, when does the cache update? I fixed the query
instead. The first page takes 2 ms. There's nothing for a cache to improve.

**4. I wanted a rate limiter. It argued me out of it, and it was right.**
It pointed out that the usual library counts requests in memory — so if you run two
copies of the service, a limit of 100 becomes 200. I then said "fine, I'll ship it and
just mention the flaw." It pushed back on that too, and I agree: shipping something you
already know is broken is worse than leaving it to the gateway. I'm including this one
because I lost the argument.

**5. It wanted me to hash passwords. I said no anyway.**
Its point was that plaintext passwords look strange next to all the other care taken
here. It's right, and bcrypt is ten minutes. I left it because it was out of scope — but
I wrote it up in section 4 instead of burying it, which was really its point.

### The one neither of us caught

This is the part I'd most want to talk about.

Fixing the date problem above, I wrote `to_json(created_at) #>> '{}' AS created_at`.
It looked fine to both of us. **Every test passed.** Then I ran `EXPLAIN` on the query
and saw this:

```
->  Parallel Seq Scan on orders
```

A full table scan. **The index had never been used — not once.**

Here's why. In `ORDER BY`, Postgres checks the names in your `SELECT` first, before the
table's real columns. I had named that formatted date `created_at`, the same as the
column. So `ORDER BY created_at DESC` was sorting the *formatted text*, not the column —
and no index can help with that.

The tests didn't catch it because dates written as text happen to sort in the same order
as real dates. The results were correct. Only the plan was wrong, and nothing was
looking at the plan.

Renaming it to `created_at_iso` took that query from **347 ms to 0.13 ms**.

A smaller version happened later: sending broken JSON returned a `500` instead of a
`400`, because Express throws its own error that my handler didn't recognise. A typo
from a client would have looked like the server crashing. I found that with curl, not
with the tests.

Both times the tests and the AI agreed with each other, and both were wrong. Actually
running the thing is what found the problem. That's why `npm run bench` exists instead
of me just claiming the index works.

### Smaller ones, for completeness

- **Prisma.** It suggested an ORM. Prisma's cursor support only handles a single unique
  column, so my two-part cursor would have ended up as raw SQL anyway.
- **Three layers.** It justified splitting route/service/repository as "useful for future
  endpoints." There are no future endpoints. I kept the split for a different reason —
  the permission rule needed its own test.
- **No `COUNT(*)` ever.** I wrote that rule first and it was too absolute. Real products
  do need counts. Softened to: not on this request.
- **Two login routes.** I asked for a separate admin login. It pointed out both would do
  identical work, so there is one.
- **`statusCode` in the response body.** I wanted it. It duplicates the HTTP status, and
  if the two disagree the client has to pick one. Dropped it.
- **Scope.** When I added roles, login and Postman, it warned this was pushing past the
  time budget and that overbuilding counts against you. I kept those but cut the empty
  folders it flagged.
- **Benchmarks after a schema change.** It pointed out that changing the schema made every
  number in this file stale. It was right and I hadn't thought about it — they were
  re-measured.

---

## 3. What breaks first at 100× the data

100× means about 500,000 users and 5 million orders.
I wanted to check one important part of the requirement:

> Will this endpoint still perform well when the number of orders becomes much larger?

The main things that matter here are the pagination strategy and the database index.

### Cursor pagination vs OFFSET

I tested three cases:

| Query                               | Rows read |      Time |
| ----------------------------------- | --------: | --------: |
| Cursor pagination                   |        20 |   0.21 ms |
| `OFFSET 10000`                      |    10,020 |  21.09 ms |
| Cursor pagination without the index |   190,036 | 165.82 ms |

The exact numbers will change depending on the machine and database state, but the difference is important.

With cursor pagination, Postgres can use the index to continue from the previous position and read only the next page of results.

With `OFFSET`, the database still needs to walk through the rows before the requested page. As the page number becomes larger, more rows need to be skipped.

The index is also important. Without it, even cursor pagination becomes much slower because Postgres has to scan many more rows to find the requested records.

### What I would expect at a much larger scale

I have not load tested this application with millions of records, so I don't want to claim exact performance numbers that I haven't measured.

But as the data grows, the things I would watch first are:

1. **Query execution time** — especially for users with a large number of orders.
2. **Query plans** — to make sure Postgres continues to use the expected index.
3. **Slow requests** — average response time can hide problems that affect only a small number of users.
4. **Database connection usage** — slow queries can keep connections busy and affect other requests.

If the application actually reached a much larger scale, I would measure the real bottleneck first before adding solutions such as caching, partitioning, or additional infrastructure.

For this assignment, the main goal was simpler: make sure the current query has a good access pattern and confirm it with actual query plans and benchmarks.

---

## 4. What I deliberately didn't build

### Password hashing — the one that needs explaining

**Passwords are stored and compared as plaintext.** That was a deliberate choice for this
exercise, not something I forgot. I'm putting it first because it sits in the same project
as a lot of care about not leaking information, and those two things look contradictory
without this paragraph.

The reasoning: the assignment is about who can read an order history, not about storing
credentials. Login only exists so the Postman collection works on its own.

In a real system the first three things I'd change: bcrypt with a salt, a comparison that
doesn't leak timing, then lockout and refresh tokens. That's maybe fifteen minutes. **It's
the one line here I wouldn't ship.**

### Everything else

**A total count.** `SELECT count(*)` for the 200,000-order account takes **27 ms**,
against **2.3 ms** for the page itself — twelve times the cost of what was actually asked
for, on every page. *I'd build it* if the UI needed "showing 20 of 1,340", but from a
cached or maintained count, not on this request.

**Rate limiting.** Belongs at the gateway. An in-app counter is wrong as soon as you run
more than one copy. *I'd build it* if there were no gateway.

**Redis.** Nothing to speed up at 2 ms. *I'd revisit* when the memory problem above
actually shows up.

**Table partitioning.** The known fix for that problem, deliberately not built early. *I'd
build it* when the index size graph starts climbing towards `shared_buffers`.

**A products table.** Nothing here needs product details, and nothing sorts or filters by
product. *I'd build it* — or call a product service — when the response needs product
names.

**Order line items.** Either a query per order or a join that multiplies rows. The brief
says orders, and a list view rarely shows contents.

**An ORM.** Prisma's cursor support only works on a single unique column, so the
`(created_at, id)` cursor would have ended up as raw SQL anyway. I'd have carried the ORM
for no benefit on the one query that matters.

**Registration, logout, refresh tokens.** Login is the minimum that makes the collection
usable.

**Filtering and sorting by status or date.** Not asked for, and each would want a
different index — I'd rather build the right index for the query that actually shows up.

**Logging, tracing, metrics.** Section 3 names the metrics I'd want, and I didn't wire any
of them up. This is the omission I'm least comfortable with.

**Docker for the app, CI, an OpenAPI spec, a migration tool.** Postgres is in Docker
because setup has to be quick; the app isn't, because it just adds a rebuild step for
someone running it once. One schema file is enough for a database recreated from scratch.
The Postman collection does what an OpenAPI spec would, and you can run it.

**More tests.** There are 22, and each pins a decision — the status codes, the ordering
including tiebreaks, pagination with no overlaps or gaps, the identical login failures,
bad input. I didn't add tests for coverage's sake. Given the index bug, I'd rather have
one test that checks a query plan than ten more checking response bodies.

---

## A note on the structure

The folder layout, file names, per-module `index.ts`, error classes, and the
`authorization()` middleware all follow a convention I already use, rather than something
invented for this exercise.

Four things from it I deliberately didn't carry over, because none survives being asked
about:

1. **The error handler registered before the routes.** Express runs middleware in order,
   so it never fires. Mine is registered last.
2. **Three queries for one login** — a count run twice, then a select. Mine is one query.
3. **A hardcoded JWT secret.** Mine comes from the environment and is checked at startup.
4. **Returning an `Error` object instead of throwing it**, then checking for it at the
   call site. Forget that check once and you have a silent auth bypass.

I also added a repository layer, which the convention doesn't have — services normally
hold the SQL. Here the SQL is the thing I care about testing, so it gets its own file.

---

## Likely questions

**Why this structure and not one file?**
Honestly, one file would work for one endpoint. The service layer is separate for one
reason: the permission rule is the riskiest code here, and I wanted to test it without
HTTP or a database in the way. That test is `tests/authorization.test.ts`.

**What happens if the input is empty?**
Empty page → empty list, null cursor, then a check for whether the user exists. Missing
token → `401` before any query runs. Empty `cursor=` → `400`, not "start from the
beginning" — that would leave a client paging forever without noticing.

**Pagination just got added as a requirement. Where does it go?**
It's already here. If it weren't: the repository for the query, `cursor.ts` for encoding,
the validator for the parameters. The service wouldn't change — it doesn't care how a page
is bounded.

**If you had to cut this in half?**
Login and Postman go, and the service folds into the route. What stays: the index, the
cursor query, the permission check happening before the database lookup, and the benchmark
script. The benchmark is last to go, because it's the only thing here that found a bug the
tests couldn't see.

---

## Known limitations

- **Passwords are plaintext.** Explained above, but it belongs here too.
- **The schema is mine, not yours.** If the real one differs on nullability or id type,
  the cursor is the first thing to revisit.
- **I never load tested it.** Everything here is the cost of one query. The connection
  pool problem in section 3 is reasoning, not measurement — that's the honest difference
  between that part and the rest.
- **The benchmarks are from one laptop** with everything in memory. The ratios should
  hold; the absolute numbers won't.
