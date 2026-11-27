
CREATE TABLE shows (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  stopped_season INTEGER, stopped_episode INTEGER,
  released_season INTEGER, released_episode INTEGER,
  genre TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'nova',
  position INTEGER NOT NULL
);
