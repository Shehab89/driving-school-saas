-- Every lesson gets a start and an end place. New sources:
--  'school'          the student has no address and there is no earlier lesson: meet at the school;
--  'previous_lesson' (end) the student has no drop-off of their own and the lesson
--                    started at the previous lesson's end point, so it ends there too.
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_pickup_source_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_pickup_source_check
  CHECK (pickup_source IS NULL OR pickup_source IN ('student','previous_lesson','staff','school'));
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_dropoff_source_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_dropoff_source_check
  CHECK (dropoff_source IS NULL OR dropoff_source IN ('student','next_lesson','previous_lesson','staff','school'));
