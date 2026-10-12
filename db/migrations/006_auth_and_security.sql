-- Account recovery, shared rate limiting, and notifications for platform-level users.

-- Platform admins (school_id NULL) can also receive a reset link, so invites and
-- notifications may exist without a school. The composite FKs keep working for
-- school rows; a plain FK covers the platform case.
ALTER TABLE user_invites ALTER COLUMN school_id DROP NOT NULL;
ALTER TABLE user_invites ADD CONSTRAINT user_invites_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX user_invites_user_open ON user_invites(user_id, purpose) WHERE used_at IS NULL;

ALTER TABLE notifications ALTER COLUMN school_id DROP NOT NULL;
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'student_welcome','user_invite','lesson_booked','lesson_reminder','lesson_rescheduled',
  'lesson_cancelled','lesson_completed_payment_request','payment_succeeded',
  'payment_overdue','reschedule_request_received','handoff_requested',
  'whatsapp_link_code','feedback_received',
  'password_reset','password_changed'));

-- Rate-limit counters shared by every app instance (fixed windows).
-- UNLOGGED: losing counters in a crash only resets limits, and it keeps writes cheap.
CREATE UNLOGGED TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window ON rate_limits(window_start);
-- Only the platform role touches it (login happens before a tenant is known).
REVOKE ALL ON rate_limits FROM dsa_app;
