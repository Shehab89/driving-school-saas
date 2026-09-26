-- Feedback read receipts: NULL until the student opens it (reset when the instructor edits it).
ALTER TABLE lesson_feedback ADD COLUMN seen_at timestamptz;
ALTER TABLE lesson_feedback ADD COLUMN updated_by uuid;
CREATE INDEX lesson_feedback_unseen ON lesson_feedback(student_id) WHERE seen_at IS NULL AND visible_to_student;
CREATE INDEX lesson_feedback_instructor ON lesson_feedback(instructor_id, updated_at DESC);

-- New notification: "your instructor left feedback".
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'student_welcome','user_invite','lesson_booked','lesson_reminder','lesson_rescheduled',
  'lesson_cancelled','lesson_completed_payment_request','payment_succeeded',
  'payment_overdue','reschedule_request_received','handoff_requested',
  'whatsapp_link_code','feedback_received'));
