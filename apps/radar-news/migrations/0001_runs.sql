-- One paid reservation and one immutable finished lot per BRT date.
CREATE TABLE runs (
  date_brt TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  start_ms INTEGER NOT NULL,
  paid_reserved INTEGER NOT NULL CHECK (paid_reserved IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('running','ok','partial','no_news','failed')),
  usable INTEGER NOT NULL DEFAULT 0 CHECK (usable IN (0, 1)),
  reason TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX runs_previous_usable ON runs (date_brt DESC) WHERE usable = 1;
