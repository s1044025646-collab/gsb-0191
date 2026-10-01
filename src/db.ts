import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

let dbInstance: DatabaseSync | null = null;
let dbPath = "";

export function openDatabase(path: string): DatabaseSync {
  if (dbInstance) {
    if (dbPath === path) return dbInstance;
    dbInstance.close();
  }
  mkdirSync(dirname(path), { recursive: true });
  dbPath = path;
  dbInstance = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  dbInstance.exec("PRAGMA journal_mode = WAL;");
  dbInstance.exec("PRAGMA foreign_keys = ON;");
  migrate(dbInstance);
  return dbInstance;
}

export function getDatabase(): DatabaseSync {
  if (!dbInstance) throw new Error("数据库尚未初始化，请先调用 openDatabase");
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS point_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL,
    points_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bounds_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_set_id INTEGER NOT NULL REFERENCES point_sets(id),
    xmin INTEGER NOT NULL, ymin INTEGER NOT NULL,
    xmax INTEGER NOT NULL, ymax INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_set_id INTEGER NOT NULL REFERENCES point_sets(id),
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_set_id INTEGER NOT NULL,
    point_set_version INTEGER NOT NULL,
    bounds_id INTEGER NOT NULL,
    config_id INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(input_hash)
  );
  `);
}
