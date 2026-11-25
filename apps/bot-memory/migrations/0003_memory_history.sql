CREATE TABLE memory_history (
  key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  text TEXT NOT NULL,
  PRIMARY KEY (key, revision)
) STRICT;
