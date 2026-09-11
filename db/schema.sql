-- Schema for the order-history endpoint.
--
-- ASSUMPTION: the brief says a schema and seed script are "provided", but none
-- were attached. This is my reconstruction. Every column below is an assumption,
-- and the three that actually change the code are called out in DECISIONS.md:
--   1. integer surrogate keys (not UUIDs)     -> affects validation + cursor encoding
--   2. orders.created_at is NOT NULL          -> required for the keyset predicate
--   3. role lives on users, not a join table  -> affects the authorization check

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text        NOT NULL UNIQUE,
    -- Role as a CHECK constraint rather than a Postgres ENUM type: adding a value
    -- to an ENUM is a migration that cannot run inside some transactions, whereas
    -- editing a CHECK is a plain ALTER. Two roles is not worth a type.
    role       text        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status       text        NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
    -- numeric, never float. Binary floating point cannot represent 0.10 exactly,
    -- so money in a float column accumulates error on every sum.
    total_amount numeric(12, 2) NOT NULL CHECK (total_amount >= 0),
    -- NOT NULL is load-bearing, not decoration. The keyset predicate is
    -- (created_at, id) < ($2, $3); a NULL created_at makes that comparison NULL,
    -- the row fails the WHERE, and the order silently vanishes from the user's
    -- history with no error and no log line.
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- The index the whole endpoint depends on.
--
-- Column order: user_id first because it is the equality predicate; the sort
-- columns follow so one index serves both the filter and the ordering.
--
-- No DESC. Postgres scans a B-tree in either direction, so an ascending index
-- satisfies ORDER BY created_at DESC, id DESC by walking backward. Explicit DESC
-- columns only earn their place on mixed-direction sorts (created_at DESC, id ASC).
--
-- id is in the index because it is the tiebreaker in the sort key. Ties on
-- created_at are common in seeded and bulk-imported data; without a tiebreaker the
-- ordering is non-deterministic and the cursor becomes unsound - pages can repeat
-- or skip rows.
CREATE INDEX idx_orders_user_id_created_at_id ON orders (user_id, created_at, id);
