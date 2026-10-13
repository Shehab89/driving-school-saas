-- Billing models, VAT, lesson packages (prepaid credits), disputes and corrections.

-- ---------------------------------------------------------------------------
-- School billing settings
-- ---------------------------------------------------------------------------
ALTER TABLE school_settings
  -- after_lesson: invoice when a lesson is completed (default, existing behaviour)
  -- at_booking:   invoice when a lesson is booked (pay in advance)
  -- credits:      lessons are paid from prepaid packages; without credit, falls back to after_lesson
  ADD COLUMN payment_mode text NOT NULL DEFAULT 'after_lesson' CHECK (payment_mode IN ('after_lesson','at_booking','credits')),
  -- VAT in basis points (2100 = 21%). Prices entered by the school include VAT by default.
  ADD COLUMN vat_rate_bps integer NOT NULL DEFAULT 2100 CHECK (vat_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN prices_include_vat boolean NOT NULL DEFAULT true,
  ADD COLUMN vat_number text CHECK (vat_number IS NULL OR length(vat_number) <= 30),
  ADD COLUMN chamber_of_commerce_number text CHECK (chamber_of_commerce_number IS NULL OR length(chamber_of_commerce_number) <= 20),
  ADD COLUMN iban text CHECK (iban IS NULL OR length(iban) <= 34),
  -- Note printed on invoices when VAT is 0 (e.g. small business scheme "KOR").
  ADD COLUMN vat_exemption_note text CHECK (vat_exemption_note IS NULL OR length(vat_exemption_note) <= 200);

-- The VAT rate used is frozen on each invoice, so later setting changes never alter issued invoices.
ALTER TABLE invoices ADD COLUMN vat_rate_bps integer NOT NULL DEFAULT 0 CHECK (vat_rate_bps BETWEEN 0 AND 10000);
ALTER TABLE invoices ADD COLUMN void_reason text;
ALTER TABLE invoices ADD COLUMN voided_at timestamptz;
ALTER TABLE invoices ADD CONSTRAINT invoices_void_has_reason CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Payment statuses: disputes (chargebacks) and lessons covered by a package
-- ---------------------------------------------------------------------------
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','paid','overdue','failed','cancelled','refunded','disputed'));
ALTER TABLE payments DROP CONSTRAINT payments_check;
ALTER TABLE payments ADD CONSTRAINT payments_paid_at_check CHECK ((status IN ('paid','refunded','disputed')) = (paid_at IS NOT NULL));
ALTER TABLE payments ADD COLUMN refund_requested_at timestamptz;
ALTER TABLE payments ADD COLUMN refund_reason text;

ALTER TABLE lessons DROP CONSTRAINT lessons_payment_status_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_payment_status_check
  CHECK (payment_status IN ('not_required','pending','paid','overdue','refunded','disputed','prepaid'));

ALTER TABLE invoice_items DROP CONSTRAINT invoice_items_kind_check;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_kind_check CHECK (kind IN ('lesson','cancellation_fee','package','other'));

-- ---------------------------------------------------------------------------
-- Lesson packages (catalogue) and the per-student credit ledger
-- ---------------------------------------------------------------------------
CREATE TABLE lesson_packages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description    text,
  lesson_count   integer NOT NULL CHECK (lesson_count BETWEEN 1 AND 200),
  price_cents    integer NOT NULL CHECK (price_cents > 0),
  currency       char(3) NOT NULL,
  -- Students can buy it themselves in the student app.
  sold_online    boolean NOT NULL DEFAULT true,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);
CREATE TRIGGER lesson_packages_updated_at BEFORE UPDATE ON lesson_packages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A purchase is an invoice for a package; credits are granted only once it is paid.
CREATE TABLE package_purchases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL,
  package_id   uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  lesson_count integer NOT NULL CHECK (lesson_count > 0),
  status       text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','credited','cancelled','refunded')),
  credited_at  timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (invoice_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, package_id) REFERENCES lesson_packages(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, invoice_id) REFERENCES invoices(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX package_purchases_student ON package_purchases(student_id, created_at DESC);

-- Append-only ledger: balance = sum(delta). Each lesson consumes at most one credit,
-- each purchase is credited at most once.
CREATE TABLE student_credit_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL,
  delta        integer NOT NULL CHECK (delta <> 0),
  reason       text NOT NULL CHECK (reason IN ('purchase','lesson','lesson_reversed','refund','adjustment')),
  purchase_id  uuid,
  lesson_id    uuid,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, purchase_id) REFERENCES package_purchases(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, lesson_id) REFERENCES lessons(school_id, id) ON DELETE RESTRICT,
  CHECK (reason <> 'adjustment' OR note IS NOT NULL)
);
CREATE INDEX student_credit_ledger_student ON student_credit_ledger(student_id, created_at DESC);
CREATE UNIQUE INDEX student_credit_ledger_purchase_once ON student_credit_ledger(purchase_id, reason) WHERE purchase_id IS NOT NULL;
CREATE UNIQUE INDEX student_credit_ledger_lesson_once ON student_credit_ledger(lesson_id, reason) WHERE lesson_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lesson_packages','package_purchases','student_credit_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id())', t);
  END LOOP;
END$$;
-- The ledger is append-only.
REVOKE UPDATE, DELETE ON student_credit_ledger FROM dsa_app, dsa_platform;

-- New notification types.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'student_welcome','user_invite','lesson_booked','lesson_reminder','lesson_rescheduled',
  'lesson_cancelled','lesson_completed_payment_request','payment_succeeded',
  'payment_overdue','reschedule_request_received','handoff_requested',
  'whatsapp_link_code','feedback_received',
  'password_reset','password_changed',
  'booking_payment_request','package_payment_request','payment_failed','payment_refunded','payment_disputed'));

-- Whether the invoice's item amounts include VAT (frozen at issue, like the rate).
ALTER TABLE invoices ADD COLUMN prices_include_vat boolean NOT NULL DEFAULT true;
