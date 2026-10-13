-- Notification preferences, WhatsApp consent and opt-out, delivery status,
-- e-mail suppression, and per-school wording of e-mails.

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
-- Students: {"reminders": {"email": true, "whatsapp": false}, "lesson_updates": {...}}
-- Payment and account e-mails are always sent and are not configurable.
ALTER TABLE students ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Staff: {"handoff": false} turns off "a WhatsApp chat needs you" e-mails.
ALTER TABLE users ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- WhatsApp consent: the student agreed (in the app, or by sending START) to receive
-- messages from the school on WhatsApp. Opt-out (in the app, or by sending STOP) wins
-- when it is more recent.
ALTER TABLE students ADD COLUMN whatsapp_opt_in_at timestamptz;
ALTER TABLE students ADD COLUMN whatsapp_opt_out_at timestamptz;
-- Contacts who are not (yet) linked to a student can also send STOP.
ALTER TABLE whatsapp_conversations ADD COLUMN opted_out_at timestamptz;

ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_intent_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_intent_check CHECK (intent IN (
  'greeting','new_student','existing_student','book_lesson','reschedule_lesson',
  'cancel_lesson','check_upcoming_lesson','payment','availability','prices',
  'school_info','human_support','other','opt_out','opt_in'));

-- Meta-approved message templates the school uses for proactive WhatsApp messages,
-- keyed by notification type: {"lesson_reminder": {"name": "lesson_reminder_v1", "language": "nl"}}.
ALTER TABLE whatsapp_accounts ADD COLUMN templates jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Delivery status and suppression
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
-- suppressed: not sent on purpose (opted out, address bounced before, preference off at send time).
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('queued','sending','sent','failed','cancelled','suppressed'));
-- What the provider reported after accepting the message (Resend / WhatsApp status webhooks).
ALTER TABLE notifications ADD COLUMN delivery_status text
  CHECK (delivery_status IN ('delivered','delayed','bounced','complained','read','failed'));
ALTER TABLE notifications ADD COLUMN delivery_updated_at timestamptz;
CREATE INDEX notifications_provider_message ON notifications(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX notifications_school_recent ON notifications(school_id, created_at DESC);

-- Addresses that hard-bounced or marked our e-mail as spam. Platform-wide, because
-- the sending domain's reputation is shared by every school.
CREATE TABLE email_suppressions (
  email                  citext PRIMARY KEY,
  reason                 text NOT NULL CHECK (reason IN ('bounced','complained','manual')),
  source_notification_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON email_suppressions FROM dsa_app;

-- ---------------------------------------------------------------------------
-- School wording of e-mails
-- ---------------------------------------------------------------------------
-- Schools can change the subject and the opening paragraph. Dates, amounts and
-- links always come from the system, so a wording change cannot break them.
CREATE TABLE notification_template_overrides (
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  type        text NOT NULL,
  subject     text CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 200),
  intro       text CHECK (intro IS NULL OR length(intro) BETWEEN 1 AND 1000),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, type),
  CHECK (subject IS NOT NULL OR intro IS NOT NULL)
);
ALTER TABLE notification_template_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_template_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_template_overrides
  USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());

-- The reminder job marks each lesson once it has been handled (sent, routed to
-- WhatsApp, or skipped because the student turned reminders off).
ALTER TABLE lessons ADD COLUMN reminder_handled_at timestamptz;
UPDATE lessons l SET reminder_handled_at = n.created_at
  FROM notifications n WHERE n.school_id = l.school_id AND n.dedupe_key = 'reminder:' || l.id;
CREATE INDEX lessons_reminder_due ON lessons(start_time) WHERE reminder_handled_at IS NULL AND status IN ('scheduled','confirmed');
