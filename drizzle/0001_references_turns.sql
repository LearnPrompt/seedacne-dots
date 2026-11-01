CREATE TABLE reference_uploads (
  owner TEXT NOT NULL,
  reference_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  phase TEXT NOT NULL,
  file_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, reference_key)
);
--> statement-breakpoint
CREATE TABLE task_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  request_key TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  phase TEXT NOT NULL,
  boundary_event_id TEXT,
  message_event_id TEXT,
  message_hash TEXT,
  base_file_ids TEXT NOT NULL DEFAULT '[]',
  output_file_ids TEXT NOT NULL DEFAULT '[]',
  output_path TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (owner, request_key, turn_key)
);
--> statement-breakpoint
CREATE UNIQUE INDEX one_active_turn ON task_turns (owner, request_key)
  WHERE phase IN ('reserved', 'submitting', 'submitted', 'needs_review');
--> statement-breakpoint
CREATE TABLE reference_mounts (
  owner TEXT NOT NULL,
  request_key TEXT NOT NULL,
  reference_key TEXT NOT NULL,
  mounted_file_id TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  PRIMARY KEY (owner, request_key, reference_key)
);
