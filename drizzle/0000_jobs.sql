CREATE TABLE jobs (
  owner TEXT NOT NULL,
  request_key TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  phase TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, request_key)
);
