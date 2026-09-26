-- Owner-managed pricing.
-- Price per lesson type for the school's default lesson length, in cents:
-- {"practical": 5500, "exam_prep": 6000, "exam": 11000, "assessment": 4500}. Missing types use default_lesson_price_cents.
ALTER TABLE school_settings ADD COLUMN lesson_type_prices jsonb NOT NULL DEFAULT '{}'::jsonb;
-- True when the owner set this lesson's price by hand; bulk price updates leave it alone.
ALTER TABLE lessons ADD COLUMN price_overridden boolean NOT NULL DEFAULT false;
