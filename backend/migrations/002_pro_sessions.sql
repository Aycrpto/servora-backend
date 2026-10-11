-- 002_pro_sessions.sql — real sign-in sessions for professionals.
--
-- Replaces the forgeable "demo-<proId>" bearer string. The client holds an
-- opaque random token (256 bits); only its SHA-256 hash is stored, so a leaked
-- database row can't be replayed as a login. Sessions expire after 30 days
-- and can be revoked (sign-out) at any time.

CREATE TABLE pro_sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,            -- hex SHA-256 of the token
  pro_id       uuid NOT NULL REFERENCES professionals (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CHECK (expires_at > created_at)
);
-- "Sign out everywhere" and housekeeping look sessions up by pro.
CREATE INDEX pro_sessions_active_pro_idx ON pro_sessions (pro_id) WHERE revoked_at IS NULL;
