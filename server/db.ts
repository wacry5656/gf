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

// 启用外键约束
db.pragma('foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS personality_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS emotion_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    mood TEXT DEFAULT 'warm',
    affection REAL DEFAULT 0.5,
    trust_score REAL DEFAULT 0.5,
    jealousy_score REAL DEFAULT 0.0,
    stability_score REAL DEFAULT 0.8,
    last_trigger TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, character_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (character_id) REFERENCES characters(id)
  );

  CREATE TABLE IF NOT EXISTS relationship_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    closeness REAL DEFAULT 0.5,
    trust REAL DEFAULT 0.5,
    dependence REAL DEFAULT 0.3,
    comfort_level REAL DEFAULT 0.5,
    phase TEXT DEFAULT 'close',
    last_event TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, character_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (character_id) REFERENCES characters(id)
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
  { sql: 'ALTER TABLE memories ADD COLUMN is_active INTEGER DEFAULT 1' },
  { sql: 'ALTER TABLE memories ADD COLUMN superseded_by INTEGER' },
  { sql: 'ALTER TABLE memories ADD COLUMN hit_count INTEGER DEFAULT 0' },
  { sql: 'ALTER TABLE memories ADD COLUMN last_hit_at TEXT' },
  { sql: "ALTER TABLE memories ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))" },
  { sql: 'ALTER TABLE memories ADD COLUMN expires_at TEXT' },
  { sql: 'ALTER TABLE memories ADD COLUMN relationship_subtype TEXT' },
  { sql: 'ALTER TABLE memories ADD COLUMN invalidation_reason TEXT' },
];

for (const m of migrations) {
  try { db.exec(m.sql); } catch { /* 列已存在，忽略 */ }
}

export default db;
