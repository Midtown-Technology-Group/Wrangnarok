ALTER TABLE connections ADD COLUMN display_name TEXT;
ALTER TABLE connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1));
ALTER TABLE connections ADD COLUMN updated_at TEXT;
