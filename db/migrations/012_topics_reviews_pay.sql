-- Lesson topics, student reviews of lessons, instructor pay rate, exam in packages.

-- Topics are the school's skills. 'planned': what the next lesson will cover
-- (set when booking, or by the instructor beforehand). 'covered': what was
-- actually practised (set with the feedback).
CREATE TABLE lesson_topics (
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  lesson_id   uuid NOT NULL,
  skill_id    uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('planned','covered')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lesson_id, kind, skill_id),
  FOREIGN KEY (school_id, lesson_id) REFERENCES lessons(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, skill_id)  REFERENCES skills(school_id, id)  ON DELETE CASCADE
);
CREATE INDEX lesson_topics_skill ON lesson_topics(skill_id);

-- The student's own rating and notes about a completed lesson. Goes to the
-- school (owner/admin); the basis of the instructor's rating.
CREATE TABLE lesson_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  lesson_id      uuid NOT NULL,
  student_id     uuid NOT NULL,
  instructor_id  uuid NOT NULL,
  rating         smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        text CHECK (comment IS NULL OR length(comment) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lesson_id),
  FOREIGN KEY (school_id, lesson_id)     REFERENCES lessons(school_id, id)     ON DELETE CASCADE,
  FOREIGN KEY (school_id, student_id)    REFERENCES students(school_id, id)    ON DELETE CASCADE,
  FOREIGN KEY (school_id, instructor_id) REFERENCES instructors(school_id, id) ON DELETE RESTRICT
);
CREATE INDEX lesson_reviews_instructor ON lesson_reviews(instructor_id, created_at DESC);
CREATE TRIGGER lesson_reviews_updated_at BEFORE UPDATE ON lesson_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lesson_topics','lesson_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id())', t);
  END LOOP;
END$$;

-- What the school pays the instructor per hour taught (cents); NULL = not set.
ALTER TABLE instructors ADD COLUMN hourly_rate_cents integer CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents BETWEEN 0 AND 100000);

-- A package can include the exam (shown to students; the exam itself is booked by the school).
ALTER TABLE lesson_packages ADD COLUMN includes_exam boolean NOT NULL DEFAULT false;
