-- Meeting point (pick-up) and end point (drop-off) for students and lessons,
-- so the planner can check that the instructor has time to drive from where
-- one lesson ends to where the next one starts.

-- The student's usual places. Drop-off NULL = same as pick-up.
ALTER TABLE students
  ADD COLUMN pickup_address  text CHECK (pickup_address IS NULL OR length(pickup_address) <= 200),
  ADD COLUMN pickup_lat      double precision CHECK (pickup_lat IS NULL OR pickup_lat BETWEEN -90 AND 90),
  ADD COLUMN pickup_lng      double precision CHECK (pickup_lng IS NULL OR pickup_lng BETWEEN -180 AND 180),
  ADD COLUMN dropoff_address text CHECK (dropoff_address IS NULL OR length(dropoff_address) <= 200),
  ADD COLUMN dropoff_lat     double precision CHECK (dropoff_lat IS NULL OR dropoff_lat BETWEEN -90 AND 90),
  ADD COLUMN dropoff_lng     double precision CHECK (dropoff_lng IS NULL OR dropoff_lng BETWEEN -180 AND 180);

-- Where each lesson actually starts and ends. Fixed when the lesson is booked.
-- pickup_source 'previous_lesson': there was not enough time to drive to the
-- student, so the lesson starts where the instructor's previous lesson ends.
-- dropoff_source 'next_lesson': the lesson ends where the next one starts.
ALTER TABLE lessons
  ADD COLUMN pickup_address  text CHECK (pickup_address IS NULL OR length(pickup_address) <= 200),
  ADD COLUMN pickup_lat      double precision,
  ADD COLUMN pickup_lng      double precision,
  ADD COLUMN pickup_source   text CHECK (pickup_source IS NULL OR pickup_source IN ('student','previous_lesson','staff')),
  ADD COLUMN dropoff_address text CHECK (dropoff_address IS NULL OR length(dropoff_address) <= 200),
  ADD COLUMN dropoff_lat     double precision,
  ADD COLUMN dropoff_lng     double precision,
  ADD COLUMN dropoff_source  text CHECK (dropoff_source IS NULL OR dropoff_source IN ('student','next_lesson','staff')),
  -- Estimated driving minutes from the previous lesson's end point (NULL = unknown or first lesson of the day).
  ADD COLUMN travel_minutes_before integer CHECK (travel_minutes_before IS NULL OR travel_minutes_before >= 0);

-- Average speed used to estimate driving time between two points (city + ring roads).
ALTER TABLE school_settings
  ADD COLUMN travel_speed_kmh integer NOT NULL DEFAULT 30 CHECK (travel_speed_kmh BETWEEN 10 AND 100);
