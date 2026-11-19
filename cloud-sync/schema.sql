CREATE TABLE IF NOT EXISTS bridge_sync (
    account_id TEXT PRIMARY KEY,
    bridge_id TEXT NOT NULL,
    source_json TEXT NOT NULL,
    source_created_at TEXT NOT NULL,
    source_written_at TEXT NOT NULL,
    result_json TEXT,
    result_written_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
);
