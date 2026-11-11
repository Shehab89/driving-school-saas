-- 1. Mileage log (kilometerregistratie / rittenregistratie).
--    A self-employed instructor (ZZP) needs, for the tax office, per trip:
--    date, odometer at start and end, from and to, business or private.
CREATE TABLE mileage_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  instructor_id uuid NOT NULL,
  vehicle_id    uuid,
  trip_date     date NOT NULL,
  start_km      integer NOT NULL CHECK (start_km BETWEEN 0 AND 9999999),
  end_km        integer NOT NULL,
  from_place    text CHECK (from_place IS NULL OR length(from_place) <= 200),
  to_place      text CHECK (to_place IS NULL OR length(to_place) <= 200),
  purpose       text NOT NULL DEFAULT 'business' CHECK (purpose IN ('business','commute','private')),
  note          text CHECK (note IS NULL OR length(note) <= 200),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_km >= start_km AND end_km - start_km <= 2000),
  FOREIGN KEY (school_id, instructor_id) REFERENCES instructors(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, vehicle_id) REFERENCES vehicles(school_id, id) ON DELETE SET NULL (vehicle_id)
);
CREATE INDEX mileage_entries_instructor ON mileage_entries(instructor_id, trip_date DESC);
CREATE INDEX mileage_entries_vehicle ON mileage_entries(vehicle_id, end_km DESC) WHERE vehicle_id IS NOT NULL;
ALTER TABLE mileage_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_entries USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());

-- 2. A message to many students at once ("closed today because of snow").
CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  -- all = every active student, upcoming = students with a lesson in the next days, instructor = one instructor's students
  audience    text NOT NULL CHECK (audience IN ('all','upcoming','instructor')),
  instructor_id uuid,
  days        integer CHECK (days IS NULL OR days BETWEEN 1 AND 30),
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  recipients  integer NOT NULL DEFAULT 0,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, instructor_id) REFERENCES instructors(school_id, id) ON DELETE SET NULL (instructor_id)
);
CREATE INDEX announcements_school ON announcements(school_id, created_at DESC);
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON announcements USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'student_welcome','user_invite','lesson_booked','lesson_reminder','lesson_rescheduled',
  'lesson_cancelled','lesson_completed_payment_request','payment_succeeded',
  'payment_overdue','reschedule_request_received','handoff_requested',
  'whatsapp_link_code','feedback_received',
  'password_reset','password_changed',
  'booking_payment_request','package_payment_request','payment_failed','payment_refunded','payment_disputed',
  'slot_opened','announcement'));

-- 3. The school's own logo and colour in the apps and e-mails.
ALTER TABLE schools ADD COLUMN brand_color text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-f]{6}$');
GRANT UPDATE (brand_color) ON schools TO dsa_app;
CREATE TABLE school_logos (
  school_id    uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  data         bytea NOT NULL CHECK (octet_length(data) <= 512000),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE school_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_logos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON school_logos USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());

-- 4. Bookkeeping export: the revenue account (grootboekrekening) the school books lessons on.
ALTER TABLE school_settings ADD COLUMN revenue_account text NOT NULL DEFAULT '8000' CHECK (length(revenue_account) BETWEEN 1 AND 20);
