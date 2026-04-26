import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

// 确保 data 目录存在
import fs from 'fs';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// 启用 WAL 模式，提升并发性能
db.pragma('journal_mode = WAL');

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    gender TEXT NOT NULL,
    personality TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (character_id) REFERENCES characters(id)
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    raw_text TEXT,
    normalized_fact_text TEXT,
    embedding TEXT NOT NULL,
    importance INTEGER DEFAULT 1,
    memory_type TEXT DEFAULT 'other',
    keywords TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    superseded_by INTEGER,
    hit_count INTEGER DEFAULT 0,
    last_hit_at TEXT,
    expires_at TEXT,
    relationship_subtype TEXT,
    invalidation_reason TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (character_id) REFERENCES characters(id)
  );

  CREATE TABLE IF NOT EXISTS memory_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL UNIQUE,
    content TEXT NOT NULL,
    memory_count_at_update INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (character_id) REFERENCES characters(id)
  );

  CREATE TABLE IF NOT EXISTS character_states (
    character_id INTEGER PRIMARY KEY,
    affection INTEGER DEFAULT 72,
    trust INTEGER DEFAULT 62,
    tension INTEGER DEFAULT 4,
    attachment INTEGER DEFAULT 64,
    mood TEXT DEFAULT 'warm',
    last_user_tone TEXT DEFAULT 'neutral',
    last_event TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (character_id) REFERENCES characters(id)
  );

  CREATE TABLE IF NOT EXISTS embedding_cache (
    cache_key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    text_preview TEXT,
    embedding TEXT NOT NULL,
    hit_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_hit_at TEXT DEFAULT (datetime('now'))
  );
`);

// ========== 兼容性迁移 ==========
const migrations: Array<{ sql: string }> = [
  { sql: 'ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 1' },
  { sql: 'ALTER TABLE memories ADD COLUMN raw_text TEXT' },
  { sql: 'ALTER TABLE memories ADD COLUMN normalized_fact_text TEXT' },
  { sql: 'ALTER TABLE memory_summaries ADD COLUMN memory_count_at_update INTEGER DEFAULT 0' },
  // v4 migrations
  { sql: "ALTER TABLE memories ADD COLUMN memory_type TEXT DEFAULT 'other'" },
  { sql: "ALTER TABLE memories ADD COLUMN keywords TEXT DEFAULT '[]'" },
  { sql: 'ALTER TABLE memories ADD COLUMN is_active INTEGER DEFAULT 1' },
  { sql: 'ALTER TABLE memories ADD COLUMN superseded_by INTEGER' },
  { sql: 'ALTER TABLE memories ADD COLUMN hit_count INTEGER DEFAULT 0' },
  { sql: 'ALTER TABLE memories ADD COLUMN last_hit_at TEXT' },
  { sql: "ALTER TABLE memories ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))" },
  { sql: 'ALTER TABLE memories ADD COLUMN expires_at TEXT' },
  { sql: 'ALTER TABLE memories ADD COLUMN relationship_subtype TEXT' },
  { sql: 'ALTER TABLE memories ADD COLUMN invalidation_reason TEXT' },
  { sql: 'ALTER TABLE character_states ADD COLUMN affection INTEGER DEFAULT 72' },
  { sql: 'ALTER TABLE character_states ADD COLUMN trust INTEGER DEFAULT 62' },
  { sql: 'ALTER TABLE character_states ADD COLUMN tension INTEGER DEFAULT 4' },
  { sql: 'ALTER TABLE character_states ADD COLUMN attachment INTEGER DEFAULT 64' },
  { sql: "ALTER TABLE character_states ADD COLUMN mood TEXT DEFAULT 'warm'" },
  { sql: "ALTER TABLE character_states ADD COLUMN last_user_tone TEXT DEFAULT 'neutral'" },
  { sql: 'ALTER TABLE character_states ADD COLUMN last_event TEXT' },
  { sql: "ALTER TABLE character_states ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))" },
];

for (const m of migrations) {
  try { db.exec(m.sql); } catch { /* 列已存在，忽略 */ }
}

export default db;
