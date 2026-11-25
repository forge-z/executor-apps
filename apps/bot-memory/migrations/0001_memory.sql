CREATE TABLE memory (
  key TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  embedding TEXT
) STRICT;
