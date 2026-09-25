-- =============================================================================
-- 001_core_schema.sql
--
-- Multi-tenant driving school SaaS. Every tenant-owned row carries school_id.
-- Isolation is enforced three ways (see docs/ARCHITECTURE.md §2):
--   1. The application always runs tenant queries inside withTenant(), which
--      sets app.school_id for the transaction.
--   2. PostgreSQL Row Level Security (FORCE'd) filters every tenant table on
--      school_id = app.school_id. Unset context => zero rows (fail closed).
--   3. Composite foreign keys (school_id, <fk>) make it impossible for a row in
--      School A to reference a student/instructor/vehicle of School B.
--
-- Money is stored as integer minor units (cents) + ISO-4217 currency code.
-- Instants are timestamptz (UTC). Wall-clock rules (opening hours, weekly
-- availability) are stored as local `time` and interpreted in schools.timezone.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraints on (uuid, tstzrange)
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_bytes for pay tokens

-- -----------------------------------------------------------------------------
-- Roles
--   dsa_app       : used by the web app for tenant-scoped work. Subject to RLS.
--   dsa_platform  : SaaS-admin console, cross-tenant webhooks routing and
--                   background jobs. BYPASSRLS. Never used for user requests
--                   that act on behalf of a school user.
-- Login roles (with passwords) are created outside migrations and granted
-- membership in one of these (see scripts/setup-dev-db.sh).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_app') THEN
    CREATE ROLE dsa_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_platform') THEN
    CREATE ROLE dsa_platform NOLOGIN BYPASSRLS;
  END IF;
END$$;

-- Current tenant from the transaction-local setting. NULL when unset, which
-- makes every RLS predicate false (fail closed).
CREATE OR REPLACE FUNCTION app_current_school_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

-- =============================================================================
-- SaaS level (not tenant-scoped)
-- =============================================================================

CREATE TABLE plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,
  name               text NOT NULL,
  monthly_price_cents integer NOT NULL CHECK (monthly_price_cents >= 0),
  currency           char(3) NOT NULL DEFAULT 'EUR',
  max_instructors    integer CHECK (max_instructors > 0),        -- NULL = unlimited
  max_active_students integer CHECK (max_active_students > 0),
  features           jsonb NOT NULL DEFAULT '{}'::jsonb,         -- {"whatsapp_ai": true, ...}
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$'),
  name        text NOT NULL,
  address     text,
  phone       text,
  email       citext,
  timezone    text NOT NULL DEFAULT 'Europe/Amsterdam',   -- IANA name, validated by the app
  currency    char(3) NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  locale      text NOT NULL DEFAULT 'en',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER schools_updated_at BEFORE UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE school_subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                 uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  plan_id                   uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status                    text NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled')),
  provider                  text,                 -- 'stripe'
  provider_subscription_id  text UNIQUE,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  trial_ends_at             timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
-- At most one non-cancelled subscription per school.
CREATE UNIQUE INDEX school_subscriptions_one_live ON school_subscriptions(school_id) WHERE status <> 'cancelled';
CREATE TRIGGER school_subscriptions_updated_at BEFORE UPDATE ON school_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Identity
-- =============================================================================

-- A user belongs to exactly one school (school_id NULL only for SaaS admins).
-- The same e-mail may exist in two schools as two independent accounts.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid REFERENCES schools(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('saas_admin','school_owner','school_admin','instructor','student')),
  email           citext NOT NULL,
  phone           text,
  password_hash   text,                           -- scrypt; NULL until invite accepted or for SSO
  auth_provider   text NOT NULL DEFAULT 'password' CHECK (auth_provider IN ('password','google','microsoft')),
  auth_subject    text,                           -- external IdP subject
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  token_version   integer NOT NULL DEFAULT 0,     -- bump to revoke all sessions
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_saas_admin_has_no_school CHECK ((role = 'saas_admin') = (school_id IS NULL)),
  CONSTRAINT users_school_id_id_key UNIQUE (school_id, id)
);
CREATE UNIQUE INDEX users_email_per_school ON users(school_id, email) WHERE school_id IS NOT NULL;
CREATE UNIQUE INDEX users_email_saas_admin ON users(email) WHERE school_id IS NULL;
CREATE UNIQUE INDEX users_external_identity ON users(auth_provider, auth_subject) WHERE auth_subject IS NOT NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,              -- sha256 of the token in the e-mail link
  purpose     text NOT NULL CHECK (purpose IN ('activate','password_reset')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, user_id) REFERENCES users(school_id, id) ON DELETE CASCADE
);

-- =============================================================================
-- School configuration
-- =============================================================================

CREATE TABLE school_settings (
  school_id                        uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  min_reschedule_notice_hours      integer NOT NULL DEFAULT 24 CHECK (min_reschedule_notice_hours BETWEEN 0 AND 720),
  min_cancellation_notice_hours    integer NOT NULL DEFAULT 24 CHECK (min_cancellation_notice_hours BETWEEN 0 AND 720),
  late_cancellation_fee_cents      integer NOT NULL DEFAULT 0 CHECK (late_cancellation_fee_cents >= 0),
  min_booking_lead_hours           integer NOT NULL DEFAULT 12 CHECK (min_booking_lead_hours BETWEEN 0 AND 720),
  booking_horizon_days             integer NOT NULL DEFAULT 28 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  default_lesson_minutes           integer NOT NULL DEFAULT 60 CHECK (default_lesson_minutes BETWEEN 15 AND 480),
  default_lesson_price_cents       integer NOT NULL DEFAULT 5500 CHECK (default_lesson_price_cents >= 0),
  slot_granularity_minutes         integer NOT NULL DEFAULT 30 CHECK (slot_granularity_minutes IN (5,10,15,20,30,60)),
  buffer_minutes                   integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 120),
  payment_due_days                 integer NOT NULL DEFAULT 7 CHECK (payment_due_days BETWEEN 0 AND 90),
  auto_payment_request             boolean NOT NULL DEFAULT true,
  reminder_hours_before            integer NOT NULL DEFAULT 24 CHECK (reminder_hours_before BETWEEN 1 AND 168),
  reschedule_requires_approval     boolean NOT NULL DEFAULT false,
  ai_agent_enabled                 boolean NOT NULL DEFAULT true,
  ai_agent_can_book                boolean NOT NULL DEFAULT true,
  school_info_for_agent            text,          -- free-text FAQ the agent may quote (prices, packages, address…)
  updated_at                       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER school_settings_updated_at BEFORE UPDATE ON school_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Weekly opening hours (several rows per weekday allowed, e.g. split shifts).
CREATE TABLE school_opening_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- ISO: 1 = Monday
  opens_at    time NOT NULL,
  closes_at   time NOT NULL,
  CHECK (closes_at > opens_at)
);
CREATE INDEX school_opening_hours_school ON school_opening_hours(school_id, weekday);

-- Holidays / closures, in local dates, inclusive.
CREATE TABLE school_closures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  reason      text,
  CHECK (ends_on >= starts_on)
);
CREATE INDEX school_closures_school ON school_closures(school_id, starts_on, ends_on);

-- Configurable progression: Level 1..N, each with a set of skills.
CREATE TABLE level_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  position        smallint NOT NULL CHECK (position > 0),
  name            text NOT NULL,
  description     text,
  -- Which AI assessment band maps onto this level (at most one level per band).
  assessment_band text CHECK (assessment_band IN ('beginner','basic','intermediate','advanced')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  UNIQUE (school_id, assessment_band)
);

CREATE TABLE skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  level_id    uuid NOT NULL,
  position    smallint NOT NULL DEFAULT 1,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (school_id, id),
  UNIQUE (level_id, name),
  FOREIGN KEY (school_id, level_id) REFERENCES level_definitions(school_id, id) ON DELETE CASCADE
);

-- =============================================================================
-- People and resources
-- =============================================================================

CREATE TABLE instructors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id             uuid,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  phone               text,
  email               citext,
  license_categories  text[] NOT NULL DEFAULT ARRAY['B'],     -- categories this instructor may teach
  default_vehicle_id  uuid,
  color               text,                                   -- calendar colour
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, user_id) REFERENCES users(school_id, id) ON DELETE SET NULL (user_id)
);
CREATE UNIQUE INDEX instructors_user ON instructors(user_id) WHERE user_id IS NOT NULL;
CREATE TRIGGER instructors_updated_at BEFORE UPDATE ON instructors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vehicles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  registration_number  text NOT NULL,
  brand                text NOT NULL,
  model                text NOT NULL,
  transmission         text NOT NULL CHECK (transmission IN ('manual','automatic')),
  vehicle_type         text NOT NULL DEFAULT 'car' CHECK (vehicle_type IN ('car','motorcycle','truck','bus','trailer','other')),
  license_category     text NOT NULL DEFAULT 'B',
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, registration_number)
);
CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE instructors
  ADD CONSTRAINT instructors_default_vehicle_fk
  FOREIGN KEY (school_id, default_vehicle_id) REFERENCES vehicles(school_id, id) ON DELETE SET NULL (default_vehicle_id);

-- Planned vehicle downtime (service, inspection…).
CREATE TABLE vehicle_unavailability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (school_id, vehicle_id) REFERENCES vehicles(school_id, id) ON DELETE CASCADE
);
CREATE INDEX vehicle_unavailability_lookup ON vehicle_unavailability(vehicle_id, starts_at, ends_at);

CREATE TABLE students (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id               uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id                 uuid,
  student_number          text NOT NULL,
  first_name              text NOT NULL,
  last_name               text NOT NULL DEFAULT '',
  phone                   text,
  phone_e164              text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),  -- normalised, used for WhatsApp matching
  email                   citext,
  date_of_birth           date,
  license_category        text NOT NULL DEFAULT 'B',
  preferred_transmission  text NOT NULL DEFAULT 'manual' CHECK (preferred_transmission IN ('manual','automatic')),
  current_level_id        uuid,
  level_confirmed         boolean NOT NULL DEFAULT false,   -- false while the level is only an AI/initial suggestion
  primary_instructor_id   uuid,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('lead','active','paused','completed','archived')),
  source                  text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','whatsapp','web','import')),
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_number),
  FOREIGN KEY (school_id, user_id) REFERENCES users(school_id, id) ON DELETE SET NULL (user_id),
  FOREIGN KEY (school_id, current_level_id) REFERENCES level_definitions(school_id, id) ON DELETE SET NULL (current_level_id),
  FOREIGN KEY (school_id, primary_instructor_id) REFERENCES instructors(school_id, id) ON DELETE SET NULL (primary_instructor_id)
);
CREATE UNIQUE INDEX students_user ON students(user_id) WHERE user_id IS NOT NULL;
-- One live student per WhatsApp number per school, so inbound messages map unambiguously.
CREATE UNIQUE INDEX students_phone_per_school ON students(school_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND status <> 'archived';
CREATE INDEX students_email ON students(school_id, email);
CREATE INDEX students_name ON students(school_id, last_name, first_name);
CREATE TRIGGER students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-school counter for human-friendly student numbers (S-0001…).
CREATE TABLE school_counters (
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name       text NOT NULL,
  value      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (school_id, name)
);

CREATE TABLE student_skill_progress (
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL,
  skill_id     uuid NOT NULL,
  status       text NOT NULL CHECK (status IN ('not_started','in_progress','needs_improvement','completed')),
  lesson_id    uuid,                                  -- lesson where it was last assessed
  updated_by   uuid,                                  -- users.id
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, skill_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, skill_id) REFERENCES skills(school_id, id) ON DELETE CASCADE
);

CREATE TABLE student_level_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL,
  from_level_id   uuid,
  to_level_id     uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('instructor','admin','assessment','import')),
  changed_by      uuid,
  lesson_id       uuid,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, to_level_id) REFERENCES level_definitions(school_id, id) ON DELETE CASCADE
);
CREATE INDEX student_level_history_student ON student_level_history(student_id, created_at DESC);

-- =============================================================================
-- Availability
-- =============================================================================

-- Weekly recurring rules (weekday set) or one-off rules (specific_date set).
CREATE TABLE instructor_availability (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  instructor_id  uuid NOT NULL,
  is_recurring   boolean NOT NULL DEFAULT true,
  weekday        smallint CHECK (weekday BETWEEN 1 AND 7),
  specific_date  date,
  start_time     time NOT NULL,
  end_time       time NOT NULL,
  valid_from     date,                 -- recurring rules may be bounded
  valid_until    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK ((is_recurring AND weekday IS NOT NULL AND specific_date IS NULL)
      OR (NOT is_recurring AND specific_date IS NOT NULL AND weekday IS NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  FOREIGN KEY (school_id, instructor_id) REFERENCES instructors(school_id, id) ON DELETE CASCADE
);
CREATE INDEX instructor_availability_lookup ON instructor_availability(instructor_id, weekday);

-- Exceptions override rules: 'unavailable' blocks time (sick day, holiday),
-- 'available' adds time outside the normal rules.
CREATE TABLE instructor_availability_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  instructor_id  uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('unavailable','available')),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (school_id, instructor_id) REFERENCES instructors(school_id, id) ON DELETE CASCADE
);
CREATE INDEX instructor_availability_exceptions_lookup ON instructor_availability_exceptions(instructor_id, starts_at, ends_at);

-- Student preferences. Used as a filter when present ("only offer me these times").
CREATE TABLE student_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE
);
CREATE INDEX student_availability_lookup ON student_availability(student_id, weekday);

-- =============================================================================
-- Lessons
-- =============================================================================

CREATE TABLE lessons (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                 uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id                uuid NOT NULL,
  instructor_id             uuid NOT NULL,
  vehicle_id                uuid,
  start_time                timestamptz NOT NULL,
  end_time                  timestamptz NOT NULL,
  -- Generated range used by the no-double-booking exclusion constraints below.
  during                    tstzrange GENERATED ALWAYS AS (tstzrange(start_time, end_time, '[)')) STORED,
  status                    text NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','confirmed','in_progress','completed','cancelled','no_show','rescheduled')),
  lesson_number             integer NOT NULL CHECK (lesson_number > 0),
  lesson_type               text NOT NULL DEFAULT 'practical' CHECK (lesson_type IN ('practical','exam_prep','exam','assessment')),
  price_cents               integer NOT NULL CHECK (price_cents >= 0),
  currency                  char(3) NOT NULL,
  payment_status            text NOT NULL DEFAULT 'not_required'
                              CHECK (payment_status IN ('not_required','pending','paid','overdue','refunded')),
  cancellation_reason       text,
  cancelled_by              uuid,
  cancelled_at              timestamptz,
  rescheduled_from_id       uuid,                  -- the lesson this one replaces
  started_at                timestamptz,
  completed_at              timestamptz,
  booked_via                text NOT NULL DEFAULT 'staff' CHECK (booked_via IN ('staff','student_portal','whatsapp_agent','import')),
  created_by                uuid,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (end_time - start_time <= interval '8 hours'),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, student_id)    REFERENCES students(school_id, id)    ON DELETE RESTRICT,
  FOREIGN KEY (school_id, instructor_id) REFERENCES instructors(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, vehicle_id)    REFERENCES vehicles(school_id, id)    ON DELETE RESTRICT,
  FOREIGN KEY (school_id, rescheduled_from_id) REFERENCES lessons(school_id, id) ON DELETE SET NULL (rescheduled_from_id),

  -- Race-proof double-booking prevention. Two concurrent transactions that
  -- try to book overlapping time for the same instructor / vehicle / student
  -- cannot both commit: the second gets SQLSTATE 23P01.
  -- Cancelled and rescheduled (superseded) lessons no longer occupy time.
  CONSTRAINT lessons_no_instructor_overlap EXCLUDE USING gist
    (instructor_id WITH =, during WITH &&) WHERE (status NOT IN ('cancelled','rescheduled')),
  CONSTRAINT lessons_no_vehicle_overlap EXCLUDE USING gist
    (vehicle_id WITH =, during WITH &&) WHERE (status NOT IN ('cancelled','rescheduled') AND vehicle_id IS NOT NULL),
  CONSTRAINT lessons_no_student_overlap EXCLUDE USING gist
    (student_id WITH =, during WITH &&) WHERE (status NOT IN ('cancelled','rescheduled'))
);
CREATE INDEX lessons_school_time ON lessons(school_id, start_time);
CREATE INDEX lessons_instructor_time ON lessons(instructor_id, start_time);
CREATE INDEX lessons_student_time ON lessons(student_id, start_time DESC);
CREATE INDEX lessons_payment_open ON lessons(school_id, payment_status) WHERE payment_status IN ('pending','overdue');
-- A lesson may be superseded by at most one live replacement.
CREATE UNIQUE INDEX lessons_single_replacement ON lessons(rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL AND status NOT IN ('cancelled','rescheduled');
CREATE TRIGGER lessons_updated_at BEFORE UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Legal status transitions, enforced in the database so no code path can skip them.
CREATE OR REPLACE FUNCTION lessons_check_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'scheduled'   AND NEW.status IN ('confirmed','in_progress','completed','cancelled','no_show','rescheduled'))
    OR (OLD.status = 'confirmed'   AND NEW.status IN ('in_progress','completed','cancelled','no_show','rescheduled'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('completed','cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal lesson status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END$$;
CREATE TRIGGER lessons_status_transition BEFORE UPDATE OF status ON lessons
  FOR EACH ROW EXECUTE FUNCTION lessons_check_transition();

CREATE TABLE lesson_feedback (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  lesson_id          uuid NOT NULL,
  student_id         uuid NOT NULL,
  instructor_id      uuid NOT NULL,
  overall_level_id   uuid,                    -- level the instructor judged this lesson at
  overall_rating     smallint CHECK (overall_rating BETWEEN 1 AND 5),
  strengths          text,                    -- "What went well"
  weaknesses         text,                    -- "What needs improvement"
  practice_items     text,                    -- "What to practice"
  next_focus         text,                    -- "Next lesson focus"
  instructor_notes   text,                    -- internal; never shown to the student
  visible_to_student boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lesson_id),
  FOREIGN KEY (school_id, lesson_id)        REFERENCES lessons(school_id, id)           ON DELETE CASCADE,
  FOREIGN KEY (school_id, student_id)       REFERENCES students(school_id, id)          ON DELETE CASCADE,
  FOREIGN KEY (school_id, instructor_id)    REFERENCES instructors(school_id, id)       ON DELETE RESTRICT,
  FOREIGN KEY (school_id, overall_level_id) REFERENCES level_definitions(school_id, id) ON DELETE SET NULL (overall_level_id)
);
CREATE INDEX lesson_feedback_student ON lesson_feedback(student_id, created_at DESC);
CREATE TRIGGER lesson_feedback_updated_at BEFORE UPDATE ON lesson_feedback FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reschedule_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  lesson_id           uuid NOT NULL,                 -- original lesson
  student_id          uuid NOT NULL,
  requested_by        uuid,                          -- users.id (NULL when via WhatsApp agent)
  channel             text NOT NULL CHECK (channel IN ('student_portal','whatsapp_agent','staff')),
  original_start      timestamptz NOT NULL,
  original_end        timestamptz NOT NULL,
  requested_start     timestamptz,                   -- the slot the student selected
  requested_end       timestamptz,
  new_lesson_id       uuid,                          -- set once the change is applied
  reason              text,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','completed','cancelled','expired')),
  decided_by          uuid,
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_end IS NULL OR requested_end > requested_start),
  FOREIGN KEY (school_id, lesson_id)     REFERENCES lessons(school_id, id)  ON DELETE CASCADE,
  FOREIGN KEY (school_id, student_id)    REFERENCES students(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, new_lesson_id) REFERENCES lessons(school_id, id)  ON DELETE SET NULL (new_lesson_id)
);
-- Only one open request per lesson.
CREATE UNIQUE INDEX reschedule_requests_one_open ON reschedule_requests(lesson_id) WHERE status IN ('pending','approved');
CREATE INDEX reschedule_requests_school_status ON reschedule_requests(school_id, status, created_at DESC);

-- =============================================================================
-- Billing
-- =============================================================================

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL,
  invoice_number  text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','paid','overdue','void','refunded')),
  subtotal_cents  integer NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents       integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents     integer GENERATED ALWAYS AS (subtotal_cents + tax_cents) STORED,
  currency        char(3) NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_date        date NOT NULL,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, invoice_number),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX invoices_student ON invoices(student_id, issued_at DESC);
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  lesson_id     uuid,
  kind          text NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson','cancellation_fee','package','other')),
  description   text NOT NULL,
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cents    integer NOT NULL CHECK (unit_cents >= 0),
  amount_cents  integer GENERATED ALWAYS AS (quantity * unit_cents) STORED,
  FOREIGN KEY (school_id, invoice_id) REFERENCES invoices(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, lesson_id)  REFERENCES lessons(school_id, id)  ON DELETE RESTRICT
);
-- A lesson is billed at most once (per kind).
CREATE UNIQUE INDEX invoice_items_lesson_once ON invoice_items(lesson_id, kind) WHERE lesson_id IS NOT NULL;

-- A payment is one attempt/obligation to collect an invoice through a provider.
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id            uuid NOT NULL,
  student_id            uuid NOT NULL,
  lesson_id             uuid,
  amount_cents          integer NOT NULL CHECK (amount_cents > 0),
  currency              char(3) NOT NULL,
  provider              text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe','manual','mollie')),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','failed','cancelled','refunded')),
  -- Stable capability URL (/pay/<token>) sent in e-mails; it creates a fresh
  -- provider checkout on click, so links never expire before the payment does.
  pay_token             text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  payment_link          text,                       -- last provider checkout URL
  provider_checkout_id  text,                       -- e.g. Stripe Checkout Session id
  provider_payment_id   text,                       -- e.g. Stripe PaymentIntent id
  reference             text NOT NULL,              -- human reference shown on e-mail / bank statement
  due_date              date NOT NULL,
  paid_at               timestamptz,
  refunded_at           timestamptz,
  recorded_by           uuid,                       -- users.id for manual (cash/bank) payments
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('paid','refunded')) = (paid_at IS NOT NULL)),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, invoice_id) REFERENCES invoices(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, lesson_id)  REFERENCES lessons(school_id, id)  ON DELETE RESTRICT
);
CREATE UNIQUE INDEX payments_provider_checkout ON payments(provider, provider_checkout_id) WHERE provider_checkout_id IS NOT NULL;
CREATE INDEX payments_student ON payments(student_id, created_at DESC);
CREATE INDEX payments_open_due ON payments(due_date) WHERE status = 'pending';
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Webhook de-duplication. Providers retry; each event is applied once.
CREATE TABLE payment_provider_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid REFERENCES schools(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  payment_id    uuid,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  error         text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- Per-school provider accounts (e.g. Stripe Connect account, so money goes
-- straight to the school).
CREATE TABLE school_payment_accounts (
  school_id            uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('stripe','mollie')),
  provider_account_id  text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, provider)
);

-- =============================================================================
-- Messaging
-- =============================================================================

CREATE TABLE notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  recipient_user_id     uuid,
  recipient_student_id  uuid,
  channel               text NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  to_address            text NOT NULL,              -- e-mail or E.164 number
  type                  text NOT NULL CHECK (type IN (
                           'student_welcome','user_invite','lesson_booked','lesson_reminder','lesson_rescheduled',
                           'lesson_cancelled','lesson_completed_payment_request','payment_succeeded',
                           'payment_overdue','reschedule_request_received','handoff_requested',
                           'whatsapp_link_code')),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- template variables
  dedupe_key            text,                               -- e.g. 'reminder:<lesson_id>'
  lesson_id             uuid,
  payment_id            uuid,
  provider              text,
  provider_message_id   text,
  attempts              smallint NOT NULL DEFAULT 0,
  last_error            text,
  scheduled_for         timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, recipient_user_id)    REFERENCES users(school_id, id)    ON DELETE SET NULL (recipient_user_id),
  FOREIGN KEY (school_id, recipient_student_id) REFERENCES students(school_id, id) ON DELETE SET NULL (recipient_student_id),
  FOREIGN KEY (school_id, lesson_id)            REFERENCES lessons(school_id, id)  ON DELETE SET NULL (lesson_id),
  FOREIGN KEY (school_id, payment_id)           REFERENCES payments(school_id, id) ON DELETE SET NULL (payment_id)
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications(school_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_queue ON notifications(scheduled_for) WHERE status = 'queued';
CREATE INDEX notifications_student ON notifications(recipient_student_id, created_at DESC);

-- Per-school WhatsApp Business number (Meta Cloud API). phone_number_id is
-- globally unique and is how inbound webhooks are routed to a tenant.
CREATE TABLE whatsapp_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id               uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  phone_number_id         text NOT NULL UNIQUE,
  waba_id                 text NOT NULL,
  display_phone_number    text NOT NULL,
  access_token_encrypted  text NOT NULL,          -- AES-256-GCM, see src/lib/crypto.ts
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id)
);

CREATE TABLE whatsapp_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  wa_phone_e164     text NOT NULL CHECK (wa_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  wa_profile_name   text,
  student_id        uuid,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','handoff','closed')),
  handoff_reason    text,
  assigned_user_id  uuid,
  agent_state       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- onboarding progress, offered slots, pending confirmation
  last_inbound_at   timestamptz,                         -- drives Meta's 24h customer-service window
  last_message_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, wa_phone_e164),
  FOREIGN KEY (school_id, student_id)       REFERENCES students(school_id, id) ON DELETE SET NULL (student_id),
  FOREIGN KEY (school_id, assigned_user_id) REFERENCES users(school_id, id)    ON DELETE SET NULL (assigned_user_id)
);
CREATE INDEX whatsapp_conversations_recent ON whatsapp_conversations(school_id, last_message_at DESC);
CREATE TRIGGER whatsapp_conversations_updated_at BEFORE UPDATE ON whatsapp_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE whatsapp_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender            text NOT NULL CHECK (sender IN ('contact','ai_agent','staff','system')),
  sender_user_id    uuid,                            -- staff member for manual replies
  wa_message_id     text UNIQUE,                     -- Meta id; UNIQUE makes webhook retries idempotent
  message_type      text NOT NULL DEFAULT 'text',
  body              text,
  intent            text CHECK (intent IN ('greeting','new_student','existing_student','book_lesson','reschedule_lesson',
                                           'cancel_lesson','check_upcoming_lesson','payment','availability','prices',
                                           'school_info','human_support','other')),
  ai_response       text,                            -- the reply the agent produced for this inbound message
  processing_status text NOT NULL DEFAULT 'done' CHECK (processing_status IN ('pending','processing','done','failed','skipped')),
  delivery_status   text CHECK (delivery_status IN ('sent','delivered','read','failed')),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- tool calls, model, token usage, raw payload refs
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, conversation_id) REFERENCES whatsapp_conversations(school_id, id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_messages_conversation ON whatsapp_messages(conversation_id, created_at);
CREATE INDEX whatsapp_messages_pending ON whatsapp_messages(created_at) WHERE processing_status = 'pending';

-- =============================================================================
-- Assessments
-- =============================================================================

CREATE TABLE assessments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL,
  source              text NOT NULL CHECK (source IN ('whatsapp_agent','web_form','instructor')),
  answers             jsonb NOT NULL,
  suggested_band      text NOT NULL CHECK (suggested_band IN ('beginner','basic','intermediate','advanced')),
  suggested_level_id  uuid,
  confidence          numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale           text,
  status              text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','overridden')),
  final_level_id      uuid,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  override_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'suggested' OR (reviewed_by IS NOT NULL AND final_level_id IS NOT NULL)),
  FOREIGN KEY (school_id, student_id)         REFERENCES students(school_id, id)          ON DELETE CASCADE,
  FOREIGN KEY (school_id, suggested_level_id) REFERENCES level_definitions(school_id, id) ON DELETE SET NULL (suggested_level_id),
  FOREIGN KEY (school_id, final_level_id)     REFERENCES level_definitions(school_id, id) ON DELETE SET NULL (final_level_id)
);
CREATE INDEX assessments_student ON assessments(student_id, created_at DESC);
CREATE INDEX assessments_review_queue ON assessments(school_id, created_at) WHERE status = 'suggested';

-- =============================================================================
-- Audit (append-only)
-- =============================================================================

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  school_id      uuid REFERENCES schools(id) ON DELETE CASCADE,
  actor_type     text NOT NULL CHECK (actor_type IN ('user','system','ai_agent','webhook')),
  actor_user_id  uuid,
  action         text NOT NULL,          -- e.g. 'lesson.completed', 'payment.marked_paid'
  entity_type    text NOT NULL,
  entity_id      uuid,
  changes        jsonb,                  -- {before:…, after:…} or relevant fields
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_school_time ON audit_logs(school_id, created_at DESC);
CREATE INDEX audit_logs_entity ON audit_logs(entity_type, entity_id);

-- =============================================================================
-- Row Level Security
-- =============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'school_subscriptions','user_invites','school_settings','school_opening_hours','school_closures',
    'level_definitions','skills','instructors','vehicles','vehicle_unavailability','students',
    'school_counters','student_skill_progress','student_level_history','instructor_availability',
    'instructor_availability_exceptions','student_availability','lessons','lesson_feedback',
    'reschedule_requests','invoices','invoice_items','payments','payment_provider_events',
    'school_payment_accounts','notifications','whatsapp_accounts','whatsapp_conversations',
    'whatsapp_messages','assessments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (school_id = app_current_school_id()) '
      'WITH CHECK (school_id = app_current_school_id())', t);
  END LOOP;
END$$;

-- schools: a tenant sees only its own row.
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schools USING (id = app_current_school_id()) WITH CHECK (id = app_current_school_id());

-- users: a tenant sees its own users; SaaS admins (school_id NULL) are invisible to tenants.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());

-- audit_logs: tenant may insert and read its own entries; nobody updates/deletes.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_logs FOR SELECT USING (school_id = app_current_school_id());
CREATE POLICY tenant_insert ON audit_logs FOR INSERT WITH CHECK (school_id = app_current_school_id());

-- plans are public reference data (read-only for tenants).
-- =============================================================================
-- Grants
-- =============================================================================
GRANT USAGE ON SCHEMA public TO dsa_app, dsa_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dsa_app, dsa_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dsa_app, dsa_platform;
REVOKE INSERT, UPDATE, DELETE ON plans FROM dsa_app;
REVOKE UPDATE, DELETE ON audit_logs FROM dsa_app, dsa_platform;
REVOKE INSERT, UPDATE, DELETE ON schools FROM dsa_app;   -- tenants edit their school via a narrow function
GRANT UPDATE (name, address, phone, email, timezone, currency, locale) ON schools TO dsa_app;

-- Tables added by later migrations get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dsa_app, dsa_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dsa_app, dsa_platform;
