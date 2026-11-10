-- 1. "Tell me when an earlier time opens": students opt in; when a lesson is
--    cancelled or moved, a few of them get a message that the time is free.
ALTER TABLE students
  ADD COLUMN earlier_slot_alert    boolean NOT NULL DEFAULT false,
  -- Last time this student got such a message (at most one every few hours).
  ADD COLUMN earlier_slot_alert_at timestamptz;

CREATE INDEX students_earlier_slot_alert ON students(school_id) WHERE earlier_slot_alert;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'student_welcome','user_invite','lesson_booked','lesson_reminder','lesson_rescheduled',
  'lesson_cancelled','lesson_completed_payment_request','payment_succeeded',
  'payment_overdue','reschedule_request_received','handoff_requested',
  'whatsapp_link_code','feedback_received',
  'password_reset','password_changed',
  'booking_payment_request','package_payment_request','payment_failed','payment_refunded','payment_disputed',
  'slot_opened'));

-- 2. Calendar link (Google / Apple / Outlook subscribe to it).
--    NULL = no link. The link carries an HMAC of (user id, version), so no
--    secret is stored; "new link" bumps the version and the old link stops.
ALTER TABLE users ADD COLUMN calendar_feed_version integer CHECK (calendar_feed_version IS NULL OR calendar_feed_version > 0);
