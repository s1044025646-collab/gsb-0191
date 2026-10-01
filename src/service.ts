import { createHash } from "node:crypto";
import { getDatabase } from "./db.js";
import { GEOMETRY_TOLERANCE } from "./constants.js";
import { delaunay } from "./geometry/delaunay.js";
import { voronoiCells } from "./geometry/voronoi.js";
import { deduplicate, validateBounds, validatePoints, ValidationError } from "./validate.js";
import {
  DEFAULT_CONFIG,
  type AlgoConfig,
  type Bounds,
  type PointSet,
  type SourcePoint,
} from "./types.js";

export interface ComputePayload {
  tolerance: number;
  input: {
    pointCount: number;
    uniqueSiteCount: number;
    duplicates: Array<{ x: number; y: number; sourceIds: string[] }>;
  };
  sites: Array<{ siteIndex: number; x: number; y: number; sourceIds: string[] }>;
  bounds: Bounds;
  config: AlgoConfig;
  triangulation: ReturnType<typeof delaunay>;
  voronoi: ReturnType<typeof voronoiCells>;
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}

export function createPointSet(name: unknown, rawPoints: unknown): PointSet {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ValidationError("点集名称必须是非空字符串");
  }
  const points = validatePoints(rawPoints);
  const db = getDatabase();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO point_sets (name, created_at, version, points_json)
       VALUES (?, ?, 1, ?)`,
    )
    .run(name.trim(), now, JSON.stringify(points));
  return { id: Number(info.lastInsertRowid), name: name.trim(), createdAt: now, points };
}

export function getPointSet(id: number): PointSet {
  const row = getDatabase()
    .prepare("SELECT id, name, created_at, version, points_json FROM point_sets WHERE id = ?")
    .get(id) as
    | { id: number; name: string; created_at: string; version: number; points_json: string }
    | undefined;
  if (!row) throw new ValidationError(`点集不存在：${id}`);
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    points: JSON.parse(row.points_json) as SourcePoint[],
  };
}

export function listPointSets(): Array<{ id: number; name: string; createdAt: string; version: number; pointCount: number }> {
  const rows = getDatabase()
    .prepare("SELECT id, name, created_at, version, points_json FROM point_sets ORDER BY id")
    .all() as Array<{ id: number; name: string; created_at: string; version: number; points_json: string }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    version: r.version,
    pointCount: (JSON.parse(r.points_json) as SourcePoint[]).length,
  }));
}

export function addPoints(pointSetId: number, rawPoints: unknown): PointSet {
  const existing = getPointSet(pointSetId);
  const additions = validatePoints(rawPoints);
  const existingIds = new Set(existing.points.map((p) => p.id));
  for (const p of additions) {
    if (existingIds.has(p.id)) {
      throw new ValidationError(`来源编号已存在：${p.id}`);
    }
  }
  const merged = [...existing.points, ...additions];
  getDatabase()
    .prepare("UPDATE point_sets SET points_json = ? WHERE id = ?")
    .run(JSON.stringify(merged), pointSetId);
  return getPointSet(pointSetId);
}

function saveBounds(pointSetId: number, b: Bounds): number {
  const info = getDatabase()
    .prepare(
      `INSERT INTO bounds_versions (point_set_id, xmin, ymin, xmax, ymax, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(pointSetId, b.xmin, b.ymin, b.xmax, b.ymax, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function saveConfig(pointSetId: number, cfg: AlgoConfig): number {
  const info = getDatabase()
    .prepare(
      "INSERT INTO config_versions (point_set_id, config_json, created_at) VALUES (?, ?, ?)",
    )
    .run(pointSetId, canonicalJson(cfg), new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/** 纯计算（不落库），供测试与导出复用。 */
export function compute(rawPoints: unknown, rawBounds: unknown, rawConfig?: unknown): ComputePayload {
  const points = validatePoints(rawPoints);
  const bounds = validateBounds(rawBounds);
  const config: AlgoConfig = { ...DEFAULT_CONFIG, ...((rawConfig as AlgoConfig) ?? {}) };
  if (
    config.degeneracyPolicy !== "canonical" ||
    config.bisectorTiePolicy !== "lower-site"
  ) {
    throw new ValidationError("仅支持 degeneracyPolicy=canonical、bisectorTiePolicy=lower-site");
  }

  const sites = deduplicate(points);
  const triangulation = delaunay(sites);
  const voronoi = voronoiCells(sites, triangulation, bounds);

  return {
    tolerance: GEOMETRY_TOLERANCE,
    input: {
      pointCount: points.length,
      uniqueSiteCount: sites.length,
      duplicates: sites
        .filter((s) => s.sourceIds.length > 1)
        .map((s) => ({ x: s.x, y: s.y, sourceIds: s.sourceIds })),
    },
    sites: sites.map((s) => ({
      siteIndex: s.siteIndex,
      x: s.x,
      y: s.y,
      sourceIds: s.sourceIds,
    })),
    bounds,
    config,
    triangulation,
    voronoi,
  };
}

/**
 * 幂等构网：以（冻结点集内容 + 边界 + 配置）的哈希作为唯一键。
 * 同一内容重复请求返回同一 result 行；新增点改变内容哈希，产生新结果，旧结果保留。
 */
export function triangulate(
  pointSetId: number,
  rawBounds: unknown,
  rawConfig?: unknown,
): { resultId: number; created: boolean; payload: ComputePayload } {
  const ps = getPointSet(pointSetId);
  const payload = compute(ps.points, rawBounds, rawConfig);

  const inputHash = createHash("sha256")
    .update(
      canonicalJson({
        pointSetId,
        points: ps.points,
        bounds: payload.bounds,
        config: payload.config,
      }),
    )
    .digest("hex");

  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM results WHERE input_hash = ?")
    .get(inputHash) as { id: number } | undefined;
  if (existing) {
    return { resultId: existing.id, created: false, payload };
  }

  const boundsId = saveBounds(pointSetId, payload.bounds);
  const configId = saveConfig(pointSetId, payload.config);
  const info = db
    .prepare(
      `INSERT INTO results
       (point_set_id, point_set_version, bounds_id, config_id, input_hash, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      pointSetId,
      1,
      boundsId,
      configId,
      inputHash,
      new Date().toISOString(),
      JSON.stringify(payload),
    );
  return { resultId: Number(info.lastInsertRowid), created: true, payload };
}

export function getResult(resultId: number): { meta: Record<string, unknown>; payload: ComputePayload } {
  const row = getDatabase()
    .prepare(
      `SELECT id, point_set_id, point_set_version, created_at, payload_json
       FROM results WHERE id = ?`,
    )
    .get(resultId) as
    | { id: number; point_set_id: number; point_set_version: number; created_at: string; payload_json: string }
    | undefined;
  if (!row) throw new ValidationError(`结果不存在：${resultId}`);
  return {
    meta: {
      resultId: row.id,
      pointSetId: row.point_set_id,
      pointSetVersion: row.point_set_version,
      createdAt: row.created_at,
    },
    payload: JSON.parse(row.payload_json) as ComputePayload,
  };
}

export interface NeighborhoodDiff {
  addedPoints: SourcePoint[];
  changedSites: number[];
  addedNeighborEdges: Array<[number, number]>;
  removedNeighborEdges: Array<[number, number]>;
}

/** 比较两次计算的 Delaunay 点邻域（旧 -> 新）。 */
export function compareNeighborhoods(before: ComputePayload, after: ComputePayload): NeighborhoodDiff {
  const edgeSet = (p: ComputePayload) => {
    const s = new Set<string>();
    for (const [site, nbs] of Object.entries(p.triangulation.neighbors)) {
      for (const n of nbs) {
        const a = Math.min(Number(site), n);
        const b = Math.max(Number(site), n);
        s.add(`${a}|${b}`);
      }
    }
    return s;
  };

  const beforeEdges = edgeSet(before);
  const afterEdges = edgeSet(after);
  const removed = [...beforeEdges].filter((e) => !afterEdges.has(e)).map(parseEdge);
  const added = [...afterEdges].filter((e) => !beforeEdges.has(e)).map(parseEdge);

  const beforeIds = new Set(before.sites.flatMap((s) => s.sourceIds));
  const addedPoints = after.input ? collectAddedPoints(after, beforeIds) : [];

  const touched = new Set<number>();
  for (const [a, b] of [...added, ...removed]) {
    touched.add(a);
    touched.add(b);
  }

  return {
    addedPoints,
    changedSites: [...touched].sort((a, b) => a - b),
    addedNeighborEdges: added.sort(edgeCmp),
    removedNeighborEdges: removed.sort(edgeCmp),
  };
}

function collectAddedPoints(after: ComputePayload, beforeIds: Set<string>): SourcePoint[] {
  const out: SourcePoint[] = [];
  for (const site of after.sites) {
    for (const id of site.sourceIds) {
      if (!beforeIds.has(id)) {
        out.push({ id, x: site.x, y: site.y });
      }
    }
  }
  return out;
}

function parseEdge(k: string): [number, number] {
  const [a, b] = k.split("|").map(Number);
  return [a, b];
}

function edgeCmp(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}
