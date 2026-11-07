-- CBR exams (the Dutch exam authority). The school still reserves exams in
-- CBR's own portal (TOP / Opleidersportaal); DriveDesk keeps the record:
-- what is reserved, when and where, the reservation number and the result,
-- plus the three things CBR needs from the student first.

-- What CBR needs before the school can reserve / the student can take the
-- practical exam. Dates are when the school saw it done (no BSN or CBR login
-- data is stored).
ALTER TABLE students
  ADD COLUMN cbr_theory_passed_on date,
  ADD COLUMN cbr_health_status text NOT NULL DEFAULT 'unknown'
    CHECK (cbr_health_status IN ('unknown','submitted','approved','rejected')),
  ADD COLUMN cbr_authorized_on date;

CREATE TABLE cbr_exams (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL,
  -- theory = theorie-examen, interim_test = tussentijdse toets (TTT),
  -- practical = praktijkexamen B, practical_anxiety = faalangstexamen, practical_be = aanhangwagen (BE)
  product             text NOT NULL CHECK (product IN ('theory','interim_test','practical','practical_anxiety','practical_be')),
  -- to_reserve = the school still has to reserve it at CBR
  status              text NOT NULL DEFAULT 'reserved' CHECK (status IN ('to_reserve','reserved','passed','failed','cancelled','no_show')),
  exam_at             timestamptz,
  location            text CHECK (location IS NULL OR length(location) <= 120),
  reservation_number  text CHECK (reservation_number IS NULL OR length(reservation_number) <= 40),
  fee_cents           integer CHECK (fee_cents IS NULL OR fee_cents BETWEEN 0 AND 1000000),
  -- The exam-day lesson (car + instructor) in DriveDesk's calendar, if booked.
  lesson_id           uuid REFERENCES lessons(id) ON DELETE SET NULL,
  result_notes        text CHECK (result_notes IS NULL OR length(result_notes) <= 2000),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE,
  CHECK (status IN ('to_reserve','cancelled') OR exam_at IS NOT NULL)
);
CREATE INDEX cbr_exams_student ON cbr_exams(student_id, exam_at DESC);
CREATE INDEX cbr_exams_school_date ON cbr_exams(school_id, exam_at);
CREATE TRIGGER cbr_exams_updated_at BEFORE UPDATE ON cbr_exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE cbr_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cbr_exams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cbr_exams USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());
