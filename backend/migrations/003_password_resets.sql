-- 003_password_resets.sql — self-serve password reset for professionals.
--
-- A reset link carries a random single-use token; only its SHA-256 hash is
-- stored. Tokens expire after 1 hour, are consumed atomically on use, and
-- issuing a new one retires any older unused ones. Rows also back the
-- per-account request limit (requests in the last hour).

CREATE TABLE password_resets (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,                 -- hex SHA-256 of the token
  pro_id      uuid NOT NULL REFERENCES professionals (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                          -- consumed, or retired by a newer request
  CHECK (expires_at > created_at)
);
CREATE INDEX password_resets_pro_idx ON password_resets (pro_id, created_at DESC);
