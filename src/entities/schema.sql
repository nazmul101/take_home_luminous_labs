-- Schema for the order-history service.
--
-- ASSUMPTION: the brief says a schema and seed script are "provided", but none were
-- attached. This is my reconstruction. Every column is an assumption; the ones that
-- actually change the code are called out in DECISIONS.md.

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS roles;
DROP FUNCTION IF EXISTS set_updated_at();

-- updated_at is maintained here, not in application code. A timestamp the app has to
-- remember to set is a timestamp that is eventually wrong, and a column that silently
-- always equals created_at is worse than no column at all.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE roles (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text        NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text        NOT NULL,
    email      text        NOT NULL UNIQUE,
    -- PLAINTEXT, DELIBERATELY. Not an oversight - see the deliberate-omissions
    -- section of DECISIONS.md, where this is argued rather than hidden. It is the one
    -- thing in this repository I would not ship to production.
    password   text        NOT NULL,
    -- Normalised to a table rather than a CHECK constraint or an enum type. The cost
    -- is a join, and that join is paid exactly once - at login - because the role name
    -- is resolved there and carried in the JWT. The order-history path never touches
    -- `roles`: it already knows the caller's role from the token.
    role_id    integer     NOT NULL REFERENCES roles (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role_id ON users (role_id);

CREATE TABLE orders (
    id           bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- No products table and no foreign key, on purpose. This is a denormalised
    -- reference to a product service that is out of scope for this assignment, not a
    -- broken relationship. Nothing in this service queries by product, so there is
    -- deliberately no index on it either.
    product_id   integer     NOT NULL,
    user_id      integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    quantity     integer     NOT NULL CHECK (quantity > 0),
    -- Money as numeric, never float. Binary floating point cannot represent 0.10
    -- exactly, so money in a float column accumulates error on every sum.
    unit_price   numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
    -- Stored rather than derived from quantity * unit_price. An order is a historical
    -- record: the total must not move when a product is repriced later. Deliberately
    -- NOT constrained to equal quantity * unit_price, because that would forbid
    -- discounts, promotions and line-level adjustments.
    total_price  numeric(12, 2) NOT NULL CHECK (total_price >= 0),
    status       text        NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
    -- NOT NULL is load-bearing, not decoration. The keyset predicate is
    -- (created_at, id) < ($3, $4); a NULL created_at makes that comparison NULL, the
    -- row fails the WHERE, and the order silently vanishes from the user's history
    -- with no error and no log line.
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The index the whole endpoint depends on.
--
-- Column order: user_id first because it is the equality predicate; the sort columns
-- follow, so one index serves both the filter and the ordering.
--
-- No DESC. Postgres scans a B-tree in either direction, so an ascending index
-- satisfies ORDER BY created_at DESC, id DESC by walking backward - the plan in
-- notes/benchmarks.md literally reads "Index Scan Backward". Explicit DESC columns
-- only earn their place on mixed-direction sorts (created_at DESC, id ASC).
--
-- id is in the index because it is the tiebreaker in the sort key. Ties on created_at
-- are common in bulk-imported data; without a tiebreaker the ordering is
-- non-deterministic and the cursor becomes unsound - pages repeat or skip rows.
CREATE INDEX idx_orders_user_id_created_at_id ON orders (user_id, created_at, id);

CREATE TRIGGER roles_set_updated_at  BEFORE UPDATE ON roles  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at  BEFORE UPDATE ON users  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
