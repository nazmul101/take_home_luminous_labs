# Project

Take-home assignment for a Senior Node.js role at Luminous Labs.
Brief: `Senior Node.js Developer — Take-Home Assignment.pdf`

Build one endpoint: `GET /api/users/:id/orders`

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

Consequence: correctness and defensibility beat completeness. When in doubt, build less and explain more.

## Architecture

See `.claude/skills/architecture/SKILL.md` — load it before creating files, adding a dependency, writing SQL, or choosing a status code. It holds the locked decisions.

The load-bearing ones, with the phrasing to use out loud:

- **Raw `pg`, no ORM** — this is a single read query where an ORM adds indirection without removing work, and Prisma's cursor helper cannot express a composite `(created_at, id)` cursor without dropping to raw SQL anyway.
- **Keyset pagination, never `OFFSET`** — O(limit) at any depth, and stable when new orders arrive mid-scroll. Costs random access; that tradeoff is named in the assumptions list.
- **No Redis** — a cache hides query cost instead of fixing it, and buys an invalidation problem that does not exist at this scale.
- **No `COUNT(*)` on the read path** — on a skewed account that is a full index scan per page request. Counts are not forbidden in general; counts per page request are.
- **No in-app rate limiting** — a memory-store counter is wrong the moment the service runs more than one instance. Rate limiting belongs at the gateway.
- **Authorize before checking existence** — otherwise the endpoint is a user-enumeration oracle for any holder of a valid token.

## Stack

Runtime: `express`, `pg`, `zod`, `jsonwebtoken`
Dev: `vitest`, `supertest`, `tsx`, `typescript`

## Commands

```
docker compose up -d     # Postgres
npm install
npm run seed             # ~5k users, ~50k orders — must stay fast
npm run seed:skew        # optional: one whale account via generate_series
npm run dev
npm test
```

`npm run seed` stays inside the five-minute setup budget. The skew seed is separate so a reviewer who just wants the service running never pays for it.

## Deliverables

| File | Purpose |
|---|---|
| `DECISIONS.md` | The graded artifact. Four questions from the brief. |
| `README.md` | Setup, verified from a clean clone. |
| `notes/ai-log.md` | Running record of model overrides. Feeds question 2. |
| `notes/benchmarks.md` | Raw `EXPLAIN ANALYZE` output. Feeds question 3. |

### The four questions DECISIONS.md must answer

1. **What did the requirements not tell you?** Every assumption, with the least-confident one marked. Current candidate for that flag: that the client needs next/prev only and never numbered pages — keyset bakes this into the response contract.
2. **What did you use AI for, and where did you override it?** Specific. "Used it for boilerplate" is explicitly called out in the brief as a non-answer.
3. **What breaks first at 100x this data?** (500k users / 5M orders.) A named mechanism plus how it would be detected before a customer reports it. Planned answer: data skew hidden behind a healthy p50 — alert on p99 and on pool acquisition wait, not on averages.
4. **What did you deliberately not build?** Omissions with reasoning, to show they were chosen rather than missed.

Close with a short section pre-answering the four questions the brief says will be asked on the call: why this structure over the obvious alternative; what happens on empty input; where pagination would go; what gets cut first.

## Working agreements

- **Ask before adding any dependency, layer, or abstraction.** Scope creep is the main risk to this submission.
- Write `notes/ai-log.md` **as work happens**. Reconstructed at the end it becomes fiction, and question 2 is designed to detect exactly that.
- Measure, do not assert. Any performance claim in `DECISIONS.md` needs a pasted query plan behind it.
- Prefer fewer tests that each pin one judgement call over coverage padding.
- State the stopping time in `DECISIONS.md`. Announced restraint reads as judgement; silent restraint reads as an unfinished submission.
- If the scope has to be trimmed, keep the benchmarks and cut tests. A model can write the argument but cannot run the database — the measurements are the part that cannot be generated.

## Open items

- [ ] **BLOCKING** — confirm `orders.created_at` is `NOT NULL`. If it is nullable, the row-value cursor predicate silently drops those rows from pagination. Resolve before writing the query.
- [ ] Schema and seed script are described in the brief as "provided" but were not in the folder — chase the email, else write them and record the assumption.
- [ ] Confirm the id type in the provided schema (`int` versus `uuid`) — it changes Zod validation and the cursor encoding.
- [ ] Decide the deleted-account case: valid token whose subject no longer exists — `404` or `401`. Pick one, record why.
- [ ] Decide whether to email the auth-boundary question (is identity assumed upstream?). The brief says asking a good question is itself a positive signal.
