import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".zozul");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "zozul.db");

export function getDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      project_path    TEXT,
      started_at      TEXT NOT NULL,
      ended_at        TEXT,
      total_input_tokens    INTEGER DEFAULT 0,
      total_output_tokens   INTEGER DEFAULT 0,
      total_cache_read_tokens    INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0,
      total_cost_usd  REAL DEFAULT 0,
      total_turns     INTEGER DEFAULT 0,
      total_duration_ms INTEGER DEFAULT 0,
      model           TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id),
      turn_index      INTEGER NOT NULL,
      role            TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      cache_read_tokens     INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd        REAL DEFAULT 0,
      duration_ms     INTEGER DEFAULT 0,
      model           TEXT,
      content_text    TEXT,
      tool_calls      TEXT,
      is_real_user    INTEGER DEFAULT 0,
      UNIQUE(session_id, turn_index)
    );

    CREATE TABLE IF NOT EXISTS tool_uses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id),
      turn_id         INTEGER REFERENCES turns(id),
      tool_name       TEXT NOT NULL,
      tool_input      TEXT,
      tool_result     TEXT,
      success         INTEGER,
      duration_ms     INTEGER DEFAULT 0,
      timestamp       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hook_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT,
      event_name      TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      payload         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otel_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      value           REAL NOT NULL,
      attributes      TEXT,
      session_id      TEXT,
      model           TEXT,
      timestamp       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otel_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name      TEXT NOT NULL,
      attributes      TEXT,
      session_id      TEXT,
      prompt_id       TEXT,
      timestamp       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_uses_session ON tool_uses(session_id);
    CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics(name, timestamp);
    CREATE INDEX IF NOT EXISTS idx_otel_metrics_session ON otel_metrics(session_id);
    CREATE INDEX IF NOT EXISTS idx_otel_events_name ON otel_events(event_name, timestamp);
    CREATE INDEX IF NOT EXISTS idx_otel_events_session ON otel_events(session_id);

    CREATE TABLE IF NOT EXISTS task_tags (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id   INTEGER NOT NULL REFERENCES turns(id),
      task      TEXT NOT NULL,
      tagged_at TEXT NOT NULL,
      UNIQUE(turn_id, task)
    );

    CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task);
    CREATE INDEX IF NOT EXISTS idx_task_tags_turn ON task_tags(turn_id);

    CREATE TABLE IF NOT EXISTS sync_watermarks (
      table_name    TEXT PRIMARY KEY,
      last_synced_id INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT
    );
  `);
}

export type SessionRow = {
  id: string;
  project_path: string | null;
  started_at: string;
  ended_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_turns: number;
  total_duration_ms: number;
  model: string | null;
};

export type TurnRow = {
  id: number;
  session_id: string;
  turn_index: number;
  role: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  duration_ms: number;
  model: string | null;
  content_text: string | null;
  tool_calls: string | null;
  is_real_user: number;
};

export type ToolUseRow = {
  id: number;
  session_id: string;
  turn_id: number | null;
  tool_name: string;
  tool_input: string | null;
  tool_result: string | null;
  success: number | null;
  duration_ms: number;
  timestamp: string;
};

export type HookEventRow = {
  id: number;
  session_id: string | null;
  event_name: string;
  timestamp: string;
  payload: string;
};

export type OtelMetricRow = {
  id: number;
  name: string;
  value: number;
  attributes: string | null;
  session_id: string | null;
  model: string | null;
  timestamp: string;
};

export type OtelEventRow = {
  id: number;
  event_name: string;
  attributes: string | null;
  session_id: string | null;
  prompt_id: string | null;
  timestamp: string;
};

export type TaskTagRow = {
  id: number;
  turn_id: number;
  task: string;
  tagged_at: string;
};
