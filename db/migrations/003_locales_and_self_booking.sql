-- Language preference per login (UI) and per student (e-mails, WhatsApp, leads without a login).
ALTER TABLE users ADD COLUMN locale text CHECK (locale IN ('en','nl','ar'));
ALTER TABLE students ADD COLUMN locale text NOT NULL DEFAULT 'nl' CHECK (locale IN ('en','nl','ar'));
ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_locale_check;
ALTER TABLE schools ADD CONSTRAINT schools_locale_check CHECK (locale IN ('en','nl','ar'));

-- Students may book free slots themselves in the student app.
ALTER TABLE school_settings ADD COLUMN student_self_booking boolean NOT NULL DEFAULT true;

-- Optional per-language names for school-defined content: {"nl": "...", "ar": "..."}.
ALTER TABLE level_definitions ADD COLUMN name_translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN name_translations jsonb NOT NULL DEFAULT '{}'::jsonb;
