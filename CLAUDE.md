# Project

Take-home assignment for a Senior Node.js role at Luminous Labs.
Brief: `Senior Node.js Developer — Take-Home Assignment.pdf`

The graded endpoint is `GET /api/users/:id/orders`.
`POST /api/auth/login` exists only so the Postman collection is self-contained.

Requirements, verbatim and complete:

1. Returns the user's orders, newest first
2. Must stay responsive as the number of orders grows
3. Handle users who have no orders
4. Only the user themself, or an admin, may view a user's orders

The brief states the spec is "deliberately incomplete — as real tickets usually are."
The gaps are the assignment. Every gap closed becomes an entry in `DECISIONS.md`.

## How this is graded — read before optimising anything

- `DECISIONS.md` is **~60% of the grade** and is read **before** the code.
- Stated criterion: "A candidate with average code and sharp reasoning will outrank one with polished code they cannot explain."
- 20-minute screen-shared call where they pick lines and ask why.
- Setup must work in **five minutes** from a clean clone or it is graded as it arrives.
- Time budget 2-3 hours is a **ceiling, not a target**. Overbuilding is a scored negative.

Consequence: correctness and defensibility beat completeness. When in doubt, build less
and explain more.

## Architecture

See `.claude/skills/architecture/SKILL.md` — load it before creating files, adding a
dependency, writing SQL, naming a file, or choosing a status code. It holds the locked
decisions.

The load-bearing ones, with the phrasing to use out loud:

- **Raw `pg`, no ORM** — a single read query where an ORM adds indirection without removing work; Prisma's cursor helper cannot express a composite `(created_at, id)` cursor without dropping to raw SQL anyway.
- **Keyset pagination, never `OFFSET`** — O(limit) at any depth, and stable when new orders arrive mid-scroll. Costs random access; that tradeoff is the flagged least-confident assumption.
- **No Redis** — a cache hides query cost instead of fixing it, and buys an invalidation problem that does not exist at this scale.
- **No `COUNT(*)` on the read path** — 27 ms against 2.3 ms for the page itself on a skewed account. Counts are not forbidden in general; counts per page request are.
- **No in-app rate limiting** — a memory-store counter is wrong the moment the service runs more than one instance.
- **Authorize before checking existence** — otherwise the endpoint is a user-enumeration oracle for any holder of a valid token.
- **One login endpoint** — the role comes from the user's row; a per-role route would do identical work.
- **No `DESC` in the index** — Postgres scans a B-tree backwards; the plan says `Index Scan Backward`.
- **Alias the rendered timestamp `created_at_iso`, never `created_at`** — see the alias bug in `notes/ai-log.md`.

## Code conventions

Structure and naming follow `nazmul5297/jwt_node_express_postgres`: modules with nested
plural subfolders (`routes/`, `services/`, `repositories/`, `validators/`, `utils/`),
per-module `index.ts` exporting `init(app)`, files named `<name>.<type>.ts`, a
`CustomError` hierarchy with `serializeErrors()`, and an `authorization()` middleware
factory.

Four things from that repo deliberately NOT copied (each is a real defect there):
error middleware registered before the routes; three queries for one login; a hardcoded
JWT secret; `return new Error(...)` checked with `instanceof`. A repository layer is a
deliberate addition. See the structure note in `DECISIONS.md`.

## Stack

Runtime: `express` 5, `pg`, `zod`, `jsonwebtoken`
Dev: `vitest` 3 (npm 10 crashes resolving vitest 4), `supertest`, `tsx`, `typescript`

## Commands

```
docker compose up -d     # Postgres on 5433
npm install
npm run setup            # schema + ~5k users, ~50k orders — must stay fast
npm run seed:skew        # optional: one whale account via generate_series
npm run dev
npm test                 # 22 tests
npm run bench            # regenerates notes/benchmarks.md
```

Seeded logins, all `password123`: `admin@example.com` (admin), `user@example.com`
(user 2, has orders), `empty@example.com` (user 3, none).

## Deliverables

| File | Purpose |
|---|---|
| `DECISIONS.md` | The graded artifact. Four questions from the brief. |
| `README.md` | Setup, verified from a clean clone. |
| `postman/` | Importable collection; login stores the token automatically. |
| `notes/ai-log.md` | Running record of model overrides. Feeds question 2. |
| `notes/benchmarks.md` | Raw `EXPLAIN ANALYZE` output. Feeds question 3. |

### The four questions DECISIONS.md must answer

1. **What did the requirements not tell you?** Every assumption, least-confident one marked. Currently flagged: the client needs next/prev only and never numbered pages — keyset bakes this into the response contract.
2. **What did you use AI for, and where did you override it?** Specific. "Used it for boilerplate" is called out in the brief as a non-answer.
3. **What breaks first at 100x this data?** Answer: the working set stops fitting in `shared_buffers` and the endpoint becomes I/O-bound; detect with a capacity metric (index size vs `shared_buffers`) weeks before latency moves.
4. **What did you deliberately not build?** Omissions with reasoning. Password hashing leads this list and must be argued, not hidden.

Close with the pre-answers to the four call questions.

## Working agreements

- **Ask before adding any dependency, layer, or abstraction.** Scope creep is the main risk.
- Write `notes/ai-log.md` **as work happens**. Reconstructed at the end it becomes fiction, and question 2 is designed to detect that.
- Measure, do not assert. Any performance claim needs a pasted query plan behind it.
- **Any schema change invalidates every number in `DECISIONS.md`** — re-run `npm run bench` and re-sync the figures.
- Prefer fewer tests that each pin one judgement call over coverage padding.
- If scope must be trimmed, keep the benchmarks and cut tests. A model can write the argument but cannot run the database.

## Open items

- [ ] Set the real stopping time in `DECISIONS.md` (currently "roughly 3 hours").
- [ ] Decide whether `.claude/` and `CLAUDE.md` ship with the submission. `notes/` should — it is the evidence for questions 2 and 3.
- [ ] Schema and seed script were described in the brief as "provided" but were not attached — chase the email; the reconstruction is recorded as an assumption.
- [ ] Decide the deleted-account case: valid token whose subject no longer exists — currently `404`, an argument exists for `401`.
- [ ] Consider emailing the auth-boundary question. The brief says asking a good one is itself a positive signal.
