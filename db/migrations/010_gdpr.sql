-- GDPR: erasure (anonymisation), retention, and what must be kept for the tax authority.

-- When a student's personal data was erased. The row stays (lessons, invoices and
-- payments refer to it) but holds no personal data afterwards.
ALTER TABLE students ADD COLUMN erased_at timestamptz;
-- When the student was archived; drives the automatic retention clean-up.
ALTER TABLE students ADD COLUMN archived_at timestamptz;
UPDATE students SET archived_at = updated_at WHERE status = 'archived';

CREATE OR REPLACE FUNCTION students_track_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'archived' AND OLD.status IS DISTINCT FROM 'archived' THEN
    NEW.archived_at := now();
  ELSIF NEW.status <> 'archived' THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END$$;
CREATE TRIGGER students_track_archive BEFORE UPDATE OF status ON students FOR EACH ROW EXECUTE FUNCTION students_track_archive();

-- Dutch tax law requires invoices to be kept for 7 years, including who was billed.
-- The name is copied onto the invoice when it is issued, so erasing the student's
-- profile later does not change issued invoices (GDPR art. 17(3)(b)).
ALTER TABLE invoices ADD COLUMN bill_to_name text;
UPDATE invoices i SET bill_to_name = trim(s.first_name || ' ' || s.last_name) FROM students s WHERE s.id = i.student_id;
CREATE OR REPLACE FUNCTION invoices_snapshot_bill_to() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bill_to_name IS NULL THEN
    SELECT trim(first_name || ' ' || last_name) INTO NEW.bill_to_name FROM students WHERE id = NEW.student_id;
  END IF;
  RETURN NEW;
END$$;
CREATE TRIGGER invoices_snapshot_bill_to BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_snapshot_bill_to();

-- How long archived students are kept before their personal data is erased
-- automatically. NULL switches automatic erasure off for the school.
ALTER TABLE school_settings ADD COLUMN retention_months integer DEFAULT 24 CHECK (retention_months IS NULL OR retention_months BETWEEN 12 AND 120);

-- The audit log is append-only for the application. Erasure is the one exception:
-- this function blanks the details of entries about one person in the caller's own
-- school (the action, time and actor stay, so the trail of *what happened* remains).
CREATE OR REPLACE FUNCTION scrub_audit_details(entity_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF app_current_school_id() IS NULL THEN
    RAISE EXCEPTION 'scrub_audit_details needs a tenant context';
  END IF;
  UPDATE audit_logs SET changes = jsonb_build_object('erased', true), ip_address = NULL
   WHERE school_id = app_current_school_id() AND entity_id = ANY(entity_ids)
     AND (changes IS NULL OR changes <> jsonb_build_object('erased', true));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END$$;
REVOKE ALL ON FUNCTION scrub_audit_details(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scrub_audit_details(uuid[]) TO dsa_app;
