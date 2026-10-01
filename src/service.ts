import { MAX_COORD, MAX_POINTS, triangulate, type SourcePoint } from './geometry.js';
import { buildCells, GEOMETRIC_TOLERANCE, polygonArea, validateRect, type ClipRect } from './voronoi.js';
import {
  DEFAULT_CONFIG,
  Store,
  type AlgoConfig,
  type InPoint,
} from './store.js';

export interface BuildOutput {
  degenerate: boolean;
  degenerateReason?: string;
  sites: Array<{ index: number; id: string; x: number; y: number; sourceIds: string[] }>;
  triangles: Array<{ id: string; vertices: [number, number, number] }>;
  hull: number[];
  adjacency: Array<{ siteIndex: number; neighbors: number[] }>;
  voronoi?: {
    rect: ClipRect;
    tolerance: number;
    cells: Array<{
      siteIndex: number;
      sourceIds: string[];
      empty: boolean;
      area: number;
      polygon: Array<[number, number]>;
      boundedBy: number[];
    }>;
    areaCheck?: { cellAreaSum: number; rectArea: number; absError: number };
  };
}

export function validatePoints(points: InPoint[]): string | null {
  if (!Array.isArray(points) || points.length === 0) return '点集为空：至少需要一个点';
  if (points.length > MAX_POINTS) return `点数超过上限 ${MAX_POINTS}（含重复位置）`;
  const ids = new Set<string>();
  for (const p of points) {
    if (typeof p.id !== 'string' || p.id.length === 0) return `存在非法编号：${JSON.stringify(p?.id)}`;
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) {
      return `点 ${p.id} 坐标必须为整数：(${p.x},${p.y})`;
    }
    if (BigInt(p.x) < -MAX_COORD || BigInt(p.x) > MAX_COORD || BigInt(p.y) < -MAX_COORD || BigInt(p.y) > MAX_COORD) {
      return `点 ${p.id} 坐标超出范围 [-1000000,1000000]：(${p.x},${p.y})`;
    }
    if (ids.has(p.id)) return `编号重复：${p.id}`;
    ids.add(p.id);
  }
  return null;
}

export function buildFromPoints(points: InPoint[], rect?: ClipRect, config: AlgoConfig = DEFAULT_CONFIG): BuildOutput {
  const err = validatePoints(points);
  if (err) throw new Error(err);
  if (rect) {
    const rerr = validateRect(rect);
    if (rerr) throw new Error(rerr);
  }

  const src: SourcePoint[] = points.map((p) => ({ id: p.id, x: BigInt(p.x), y: BigInt(p.y) }));
  const tr = triangulate(src);

  const out: BuildOutput = {
    degenerate: tr.degenerate,
    degenerateReason: tr.degenerateReason,
    sites: tr.sites.map((s, index) => ({
      index,
      id: s.id,
      x: Number(s.x),
      y: Number(s.y),
      sourceIds: s.sourceIds,
    })),
    triangles: tr.triangles.map((t, i) => ({ id: `T${i + 1}`, vertices: t.v })),
    hull: tr.hull,
    adjacency: tr.adjacency,
  };

  if (rect) {
    const cells = buildCells(tr, rect);
    const rectArea = (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
    const sum = cells.reduce((s, c) => s + c.area, 0);
    out.voronoi = {
      rect,
      tolerance: config.tolerance ?? GEOMETRIC_TOLERANCE,
      cells: cells.map((c) => ({
        siteIndex: c.siteIndex,
        sourceIds: c.sourceIds,
        empty: c.empty,
        area: c.area,
        polygon: c.polygon,
        boundedBy: c.boundedBy,
      })),
      areaCheck: {
        cellAreaSum: sum,
        rectArea,
        absError: Math.abs(sum - rectArea),
      },
    };
  }
  return out;
}

export interface NeighborDiff {
  added: Record<string, string[]>;
  removed: Record<string, string[]>;
  /** 两版本间站点索引位置的含义不同，按来源编号对齐比较 */
  sharedUnchanged: string[];
}

/** 以“来源编号 -> 邻居来源编号集合”比较两版构网结果 */
export function compareNeighborSets(a: BuildOutput, b: BuildOutput): NeighborDiff {
  const map = (o: BuildOutput) => {
    const indexToIds = new Map<number, string[]>();
    for (const s of o.sites) indexToIds.set(s.index, s.sourceIds);
    const byId = new Map<string, Set<string>>();
    for (const adj of o.adjacency) {
      const ids = indexToIds.get(adj.siteIndex)!;
      const ns = new Set<string>();
      for (const ni of adj.neighbors) for (const id of indexToIds.get(ni)!) ns.add(id);
      for (const id of ids) byId.set(id, ns);
    }
    return byId;
  };
  const ma = map(a);
  const mb = map(b);
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  const sharedUnchanged: string[] = [];
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  for (const k of [...keys].sort()) {
    const sa = ma.get(k);
    const sb = mb.get(k);
    if (!sa && sb) {
      added[k] = [...sb].sort();
    } else if (sa && !sb) {
      removed[k] = [...sa].sort();
    } else if (sa && sb) {
      const add = [...sb].filter((x) => !sa.has(x)).sort();
      const rem = [...sa].filter((x) => !sb.has(x)).sort();
      if (add.length) added[k] = add;
      if (rem.length) removed[k] = rem;
      if (!add.length && !rem.length) sharedUnchanged.push(k);
    }
  }
  return { added, removed, sharedUnchanged };
}

export function exportJson(result: BuildOutput): string {
  return JSON.stringify(result, null, 2);
}

export function exportCsv(result: BuildOutput, kind: 'points' | 'triangles' | 'cells' = 'triangles'): string {
  if (kind === 'points') {
    const rows = ['site_index,primary_id,x,y,source_ids'];
    for (const s of result.sites) {
      rows.push(`${s.index},${s.id},${s.x},${s.y},"${s.sourceIds.join('|')}"`);
    }
    return rows.join('\n');
  }
  if (kind === 'cells' && result.voronoi) {
    const rows = ['site_index,source_ids,empty,area,polygon_wkt'];
    for (const c of result.voronoi.cells) {
      const wkt = c.empty
        ? 'EMPTY'
        : 'POLYGON ((' + [...c.polygon, c.polygon[0]].map(([x, y]) => `${x} ${y}`).join(', ') + '))';
      rows.push(`${c.siteIndex},"${c.sourceIds.join('|')}",${c.empty},${c.area},"${wkt}"`);
    }
    return rows.join('\n');
  }
  const rows = ['triangle_id,v1,v2,v3'];
  for (const t of result.triangles) rows.push(`${t.id},${t.vertices[0]},${t.vertices[1]},${t.vertices[2]}`);
  return rows.join('\n');
}

export function parsePointsCsv(text: string): InPoint[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const points: InPoint[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /id|编号/i.test(line)) continue;
    const [id, x, y] = line.split(',').map((s) => s.trim());
    points.push({ id, x: Number(x), y: Number(y) });
  }
  return points;
}

export { Store, DEFAULT_CONFIG, polygonArea };
