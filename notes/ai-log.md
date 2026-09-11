# AI log

Running record of where the model was used, where it was overridden, and where it
was right and I was wrong. Written as the work happened. This is the raw material
for question 2 in DECISIONS.md.

Model used: Claude Opus 5 in Claude Code, throughout.

---

## 1. Redis — I killed it before a line was written

**Model proposed:** happily went along with adding Redis to the stack when I raised it.

**I overrode it.** A cache in front of this endpoint hides the query cost instead
of fixing it: p50 looks fine while the cold path and p99 stay broken, and I would
have inherited an invalidation problem (when does a new order appear in history?)
to solve a problem I do not have at 50k rows.

**What I did instead:** fixed the query. Index plus keyset pagination. The
benchmark later showed the first page at 2.09 ms p50 — there is nothing for a cache
to improve.

---

## 2. Prisma — rejected, for a reason specific to this query

**Model's default instinct** on a Node plus Postgres service is an ORM.

**I overrode it.** Prisma's `cursor` helper only works on a unique column. This
endpoint needs a composite cursor over `(created_at, id)`, which in Prisma has to
be written as an `OR` expansion — and that plans differently from the SQL row-value
comparison `(created_at, id) < ($3, $4)`. I would have ended up in `$queryRaw` for
the one query that matters, with an ORM carried for nothing.

Secondary reason: I have to defend every line in a 20-minute call, and "let me
check what Prisma generated" is not a defence.

---

## 3. Index direction — the model wrote `DESC`, and it was cargo-cult

**Model proposed:** `CREATE INDEX ... ON orders (user_id, created_at DESC, id DESC)`.

**I challenged it.** Postgres scans a B-tree in either direction, so an ascending
index already satisfies `ORDER BY created_at DESC, id DESC`. Explicit `DESC`
columns only earn their place on *mixed*-direction sorts such as
`created_at DESC, id ASC`. The model agreed on being asked, which means it had
produced a plausible-looking index it could not justify.

**Changed to:** `(user_id, created_at, id)`.

**Confirmed by measurement.** The plan in `notes/benchmarks.md` reads
`Index Scan Backward using idx_orders_user_id_created_at_id` — Postgres walking the
ascending index backwards, exactly as predicted.

---

## 4. Rate limiting — I asked for it, the model talked me out of it, and it was right

I wanted `express-rate-limit` in the stack. The model pointed out that the default
memory store gives each process its own counter, so a limit of N becomes N times
the instance count — the component is simply incorrect the moment the service
scales horizontally.

My follow-up position was "ship it and document the flaw." The model pushed back on
that too: shipping something you have already established is wrong, with a footnote
admitting it, is a worse story than leaving it at the edge where it belongs.

**I reverted.** No rate limiting in the app; it is in the deliberate-omissions
list with that reasoning. Recording this one because it went against me.

---

## 5. Three layers — the model's justification was wrong even though the structure was right

**Model proposed** controller / service / repository, justified as "the authz rule
will apply to every future user-scoped endpoint."

**I rejected the justification.** There are no future endpoints. That is
speculative generality, and this brief explicitly punishes building for imagined
futures.

**Kept the structure, changed the reason:** the service layer exists because
`assertMayViewOrders` is the highest-risk logic here and deserves a unit test with
no HTTP and no database in the way. That is a present-tense reason, and
`tests/authorization.test.ts` is the thing that makes it true rather than
decorative.

---

## 6. `COUNT(*)` — I over-corrected and had to walk it back

I initially wrote a blanket rule: no `COUNT(*)` anywhere, ever. On review that is
dogma — real products legitimately need "showing 20 of 1,340", and a blanket ban
invites the obvious rebuttal.

**Softened to:** no count *on the read path*, per page request. A product that needs
a total gets it from an approximate count, a maintained counter, or a separate
endpoint. The measurement supports the narrow claim and not the broad one:
`count(*)` for the 200k-order account is 27.23 ms against 2.32 ms for the page
itself.

---

## 7. Timestamp precision — the model's first cursor would have looped forever

**Model's first draft** encoded the cursor from a JS `Date` returned by node-postgres.

**I caught it:** Postgres `timestamptz` stores microseconds, a JS `Date` holds
milliseconds. Encoding `2026-01-01T00:00:00.123456Z` as `...123Z` produces a
predicate that fails to exclude the row it was built from, so the last row of each
page repeats — a pagination loop that looks like success from the outside.

**Fixed by** rendering the timestamp to ISO text in SQL, so the cursor is
byte-exact with what the database stored.

---

## 8. The alias bug — neither of us caught it; the benchmark did

This is the one worth reading.

The fix for item 7 was `to_json(created_at) #>> '{}' AS created_at`. Both of us
were satisfied. **All 17 tests passed.**

Then `EXPLAIN` showed:

```
Sort Key: ((to_json(created_at) #>> '{}'::text[])) DESC, id DESC
->  Parallel Seq Scan on orders
```

Sequential scan. The index was never used, in any query, from the first commit.

**Cause:** Postgres resolves a bare identifier in `ORDER BY` against the SELECT
output names before the table columns. Aliasing the expression as `created_at`
meant `ORDER BY created_at DESC` sorted by the rendered *text*, not the column — an
expression no index covers.

**Why the tests missed it:** ISO 8601 text sorts lexicographically in the same
order as the timestamps it encodes. The results were correct. Only the plan was
wrong, and no assertion looks at the plan.

**Fixed by** aliasing to `created_at_iso` so the identifier in `ORDER BY` is
unambiguous. 347 ms to 0.13 ms on the same query.

The lesson I am taking to the call: the tests and the model agreed with each other
and were both wrong. The measurement was the only thing in the process that could
have caught this, which is the argument for running `EXPLAIN` rather than asserting
that an index "should" be used.

---

## 9. Passwords — the model argued hard for hashing; I overruled it

**Model's position:** plaintext passwords contradict the enumeration-leak care taken
everywhere else in the submission. A reviewer reads the 403-before-existence argument
in DECISIONS.md, opens schema.sql, and finds passwords in the clear. `bcrypt` is one
dependency and about ten minutes.

**I overruled it.** Out of scope for this exercise: the brief asks who may read an
order history, not how credentials are stored, and login exists only so the Postman
collection is self-contained.

**What I took from its argument anyway:** it is now the *first* entry in the
deliberate-omissions section, with the remediation order spelled out, rather than a
line in schema.sql nobody reads. The model's real point was not "hash it" but "these
two facts cannot sit in one repository without an explanation" — and that part I
accepted.

---

## 10. Two login endpoints — I asked, the model refused

I specified `/auth/admin/login` and `/auth/user/login`.

**Model pushed back:** both do identical work — check credentials, mint a token — since
the role comes from the user's row either way. Two routes invites "why two?" with no
good answer, and implies an admin cannot authenticate through the ordinary one.

**I agreed.** One `POST /api/auth/login`.

---

## 11. `statusCode` in the response body — I proposed it, it talked me down

I wanted `{ statusCode, data }`. The model pointed out it duplicates the HTTP status,
and that if the two ever disagree the client has to pick a winner.

Settled on `{ success, message, data, meta }`, with pagination in `meta` so `data`
stays a clean array.

---

## 12. Scope — the model flagged my own instructions as over-budget

When I specified roles, login, Postman and a full restructure, the model's first
response was that this pushes past the brief's 2-3 hour ceiling and that overbuilding
is a scored negative. It recommended dropping the per-module `error/` and `utils/`
folders unless they had real content.

**I kept the scope** — login and Postman make the thing testable, which the brief cares
about — **and took the folder advice.** There is no empty scaffolding in `modules/`.

It also flagged that changing the schema invalidates every benchmark number already
written into DECISIONS.md. That was correct and I had not thought about it; the figures
were re-measured and re-synced rather than left stale.

---

## 13. Malformed JSON returned 500 — found by hand, not by the suite

Discovered while smoke-testing the finished service with curl: a request body that is
not valid JSON came back **500**, not 400.

**Cause:** `express.json()` rejects a bad body with its own `SyntaxError`, decorated
with `type: 'entity.parse.failed'` and `status: 400`. The global error handler matched
`CustomError` and `ZodError`, then fell through to the catch-all 500.

**Why it matters more than it looks:** a client typo would have been reported as a
server fault. In production that pages whoever is on call and buries real outages in
noise from malformed requests.

**Fixed** by matching the body-parser shape in `error-handler.middle.ts`, plus a regression
test in `tests/auth.test.ts`.

The pattern is the same as the alias bug: 21 passing tests, and neither the model nor
the tests looked at the path a client actually takes when it sends something wrong. Two
of the three real defects in this build were found by exercising the system rather than
by asserting on it.

---

## Where the model was straightforwardly useful

- Express and TypeScript scaffolding, `tsconfig`, `docker-compose`, npm scripts.
- Turning "seed 50k rows" into set-based `generate_series` inserts rather than a
  loop of 50,000 round trips (8.7 s instead of minutes — the five-minute setup rule).
- Drafting the test bodies once I had specified what each test needed to pin.
- The Postman collection scaffolding, including the login test script that stores
  the token into a collection variable so a reviewer never copies one by hand.
- Spotting that `npm audit` had a critical advisory in the dev tree and that it was
  vitest/vite, not anything shipped.

## Where I had to correct the environment, not the model

`npm install` crashed with `Cannot read properties of null (reading 'edgesOut')` —
an npm 10 arborist bug triggered by vitest 4's optional peer graph, not anything in
this project. Pinned vitest to 3.2.x. Moved Express to 5.x, which clears the `qs`
advisory; production dependencies now audit clean, with one moderate dev-only
advisory remaining in `@vitest/mocker`.
