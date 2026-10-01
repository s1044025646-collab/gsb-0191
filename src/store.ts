import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface InPoint {
  id: string;
  x: number;
  y: number;
}

export interface RectSpec {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AlgoConfig {
  tolerance: number;
  tieRule: string;
}

export interface PointSetRow {
  id: number;
  name: string;
  points_hash: string;
  points_json: string;
  created_at: string;
}

export interface BoundaryRow {
  id: number;
  pointset_id: number;
  rect_json: string;
  rect_hash: string;
  created_at: string;
}

export interface ResultRow {
  id: number;
  pointset_id: number;
  boundary_id: number | null;
  config_json: string;
  result_json: string;
  created_at: string;
}

export function hashJson(value: unknown): string {
  const json = JSON.stringify(value);
  let h1 = 0xdeadbeef ^ json.length;
  let h2 = 0x41c6ce57 ^ json.length;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0');
  return `sha1x_${hex}`;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pointsets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        points_hash TEXT NOT NULL UNIQUE,
        points_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS boundaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pointset_id INTEGER NOT NULL REFERENCES pointsets(id),
        rect_hash TEXT NOT NULL,
        rect_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(pointset_id, rect_hash)
      );
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pointset_id INTEGER NOT NULL,
        boundary_id INTEGER,
        config_hash TEXT NOT NULL,
        config_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(pointset_id, boundary_id, config_hash)
      );
    `);
  }

  close() {
    this.db.close();
  }

  /** 幂等导入：同一内容（含顺序与重复点）只产生一条点集记录 */
  upsertPointSet(name: string, points: InPoint[]): { row: PointSetRow; created: boolean } {
    const h = hashJson({ name, points });
    const found = this.db.prepare('SELECT * FROM pointsets WHERE points_hash = ?').get(h) as unknown as PointSetRow | undefined;
    if (found) return { row: found, created: false };
    const info = this.db
      .prepare('INSERT INTO pointsets (name, points_hash, points_json) VALUES (?,?,?)')
      .run(name, h, JSON.stringify(points));
    const row = this.db.prepare('SELECT * FROM pointsets WHERE id = ?').get(info.lastInsertRowid) as unknown as PointSetRow;
    return { row, created: true };
  }

  getPointSet(id: number): PointSetRow | undefined {
    return this.db.prepare('SELECT * FROM pointsets WHERE id = ?').get(id) as unknown as PointSetRow | undefined;
  }

  listPointSets(): PointSetRow[] {
    return this.db.prepare('SELECT * FROM pointsets ORDER BY id').all() as unknown as PointSetRow[];
  }

  /** 在已冻结点集上“追加点” => 产生一个全新点集版本；旧点集与结果不受影响 */
  appendPoints(baseId: number, extra: InPoint[], newName?: string): PointSetRow {
    const base = this.getPointSet(baseId);
    if (!base) throw new Error(`点集不存在：${baseId}`);
    const basePts = JSON.parse(base.points_json) as InPoint[];
    return this.upsertPointSet(newName ?? `${base.name}#v${Date.now()}`, [...basePts, ...extra]).row;
  }

  upsertBoundary(pointsetId: number, rect: RectSpec): { row: BoundaryRow; created: boolean } {
    if (!this.getPointSet(pointsetId)) throw new Error(`点集不存在：${pointsetId}`);
    const h = hashJson(rect);
    const found = this.db
      .prepare('SELECT * FROM boundaries WHERE pointset_id = ? AND rect_hash = ?')
      .get(pointsetId, h) as unknown as BoundaryRow | undefined;
    if (found) return { row: found, created: false };
    const info = this.db
      .prepare('INSERT INTO boundaries (pointset_id, rect_hash, rect_json) VALUES (?,?,?)')
      .run(pointsetId, h, JSON.stringify(rect));
    const row = this.db.prepare('SELECT * FROM boundaries WHERE id = ?').get(info.lastInsertRowid) as unknown as BoundaryRow;
    return { row, created: true };
  }

  getBoundary(id: number): BoundaryRow | undefined {
    return this.db.prepare('SELECT * FROM boundaries WHERE id = ?').get(id) as unknown as BoundaryRow | undefined;
  }

  /** 幂等结果：同一点集 + 同一裁剪矩形 + 同一配置只保存一次 */
  saveResult(pointsetId: number, boundaryId: number | null, config: AlgoConfig, result: unknown): { row: ResultRow; created: boolean } {
    const ch = hashJson(config);
    const found = this.db
      .prepare('SELECT * FROM results WHERE pointset_id = ? AND COALESCE(boundary_id,-1) = COALESCE(?,-1) AND config_hash = ?')
      .get(pointsetId, boundaryId, ch) as unknown as ResultRow | undefined;
    if (found) return { row: found, created: false };
    const info = this.db
      .prepare('INSERT INTO results (pointset_id, boundary_id, config_hash, config_json, result_json) VALUES (?,?,?,?,?)')
      .run(pointsetId, boundaryId, ch, JSON.stringify(config), JSON.stringify(result));
    const row = this.db.prepare('SELECT * FROM results WHERE id = ?').get(info.lastInsertRowid) as unknown as ResultRow;
    return { row, created: true };
  }

  getResult(id: number): ResultRow | undefined {
    return this.db.prepare('SELECT * FROM results WHERE id = ?').get(id) as unknown as ResultRow | undefined;
  }

  listResults(pointsetId?: number): ResultRow[] {
    if (pointsetId === undefined) return this.db.prepare('SELECT * FROM results ORDER BY id').all() as unknown as ResultRow[];
    return this.db.prepare('SELECT * FROM results WHERE pointset_id = ? ORDER BY id').all(pointsetId) as unknown as ResultRow[];
  }
}

export const DEFAULT_CONFIG: AlgoConfig = { tolerance: 1e-9, tieRule: 'source-id-lex-min' };
