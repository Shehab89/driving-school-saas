-- Fixes from the 2026-11-05 QA review.

-- 1. Signing out revokes that one session server-side. Each session token
--    carries a random id (jti); signing out records it here until the token
--    would have expired anyway. Ids are random UUIDs and useless without the
--    signed token, so the tenant role may read and add them (no RLS needed).
CREATE TABLE revoked_sessions (
  jti        uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX revoked_sessions_expiry ON revoked_sessions(expires_at);
REVOKE UPDATE ON revoked_sessions FROM dsa_app, dsa_platform;
REVOKE DELETE ON revoked_sessions FROM dsa_app;

-- 2. Cap on lessons a student (or the WhatsApp assistant for them) may have
--    booked ahead at once. NULL = no limit. Staff are never capped.
ALTER TABLE school_settings
  ADD COLUMN max_upcoming_self_bookings integer DEFAULT 3
  CHECK (max_upcoming_self_bookings IS NULL OR max_upcoming_self_bookings BETWEEN 1 AND 50);
