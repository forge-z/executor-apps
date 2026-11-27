
CREATE TABLE episodes (
  id TEXT PRIMARY KEY NOT NULL, show_id TEXT NOT NULL,
  season INTEGER NOT NULL, episode INTEGER NOT NULL, watched INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX episodes_show ON episodes (show_id, season, episode);
