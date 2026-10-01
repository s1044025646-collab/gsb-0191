/**
 * 精确二维几何核心：BigInt 方向谓词 / 圆内谓词 + Bowyer-Watson 增量剖分。
 * 所有站点坐标为整数；输出顶点顺序统一为逆时针（CCW，orient > 0）。
 */

export const MAX_COORD = 1_000_000n;
export const MAX_POINTS = 10_000;

export function posKey(x: bigint, y: bigint): string {
  return `${x},${y}`;
}

export interface SourcePoint {
  id: string;
  x: bigint;
  y: bigint;
}

export interface Site extends SourcePoint {
  sourceIds: string[];
}

export interface Tri {
  v: [number, number, number];
}

export interface NeighborInfo {
  siteIndex: number;
  neighbors: number[];
}

export interface TriangulationResult {
  sites: Site[];
  indexBySource: Map<string, number>;
  triangles: Tri[];
 hull: number[];
  edgeTriangles: Map<string, number[]>;
  adjacency: NeighborInfo[];
  degenerate: boolean;
  degenerateReason?: string;
}

/** >0: c 在 ab 左侧（CCW）；=0 共线；<0 右侧。 */
export function orient(a: { x: bigint; y: bigint }, b: { x: bigint; y: bigint }, c: { x: bigint; y: bigint }): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * 严格圆内谓词。a,b,c 必须逆时针：
 *   >0 p 在开外接圆内；=0 四点共圆；<0 在圆外。
 */
export function inCircle(
  a: { x: bigint; y: bigint },
  b: { x: bigint; y: bigint },
  c: { x: bigint; y: bigint },
  p: { x: bigint; y: bigint },
): bigint {
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  const ad = ax * ax + ay * ay;
  const bd = bx * bx + by * by;
  const cd = cx * cx + cy * cy;
  return (
    ad * (bx * cy - cx * by) -
    bd * (ax * cy - cx * ay) +
    cd * (ax * by - bx * ay)
  );
}

interface RTri {
  v: [number, number, number];
  alive: boolean;
}

function edgeKey(i: number, j: number): string {
  return i < j ? `${i},${j}` : `${j},${i}`;
}

/**
 * 退化处理规则：
 *  - 唯一位置 < 3 或全部位置共线：不产生三角形，凸包为沿线排序的点链。
 *  - 重复坐标聚合为一个站点，保留全部来源编号。
 *  - 四点共圆：严格开圆判据（圆上点不触发空洞），结果仅由坐标集合决定。
 */
export function triangulate(input: SourcePoint[]): TriangulationResult {
  if (input.length === 0) {
    return emptyResult([], new Map(), true, '点集为空');
  }
  for (const p of input) {
    if (p.x < -MAX_COORD || p.x > MAX_COORD || p.y < -MAX_COORD || p.y > MAX_COORD) {
      throw new Error(`坐标超出允许范围 [${-MAX_COORD}, ${MAX_COORD}]：${p.id}=(${p.x},${p.y})`);
    }
  }

  const byKey = new Map<string, { x: bigint; y: bigint; ids: string[] }>();
  const seenId = new Set<string>();
  for (const p of input) {
    const k = posKey(p.x, p.y);
    let g = byKey.get(k);
    if (!g) {
      g = { x: p.x, y: p.y, ids: [] };
      byKey.set(k, g);
    }
    if (!seenId.has(p.id)) {
      g.ids.push(p.id);
      seenId.add(p.id);
    }
  }
  const groups = [...byKey.values()].sort((a, b) =>
    a.x < b.x ? -1 : a.x > b.x ? 1 : a.y < b.y ? -1 : a.y > b.y ? 1 : 0,
  );
  const sites: Site[] = groups.map((g) => ({
    id: g.ids[0],
    x: g.x,
    y: g.y,
    sourceIds: g.ids,
  }));
  const indexBySource = new Map<string, number>();
  sites.forEach((s, i) => s.sourceIds.forEach((id) => indexBySource.set(id, i)));

  if (sites.length > MAX_POINTS) {
    throw new Error(`唯一位置数量超过上限 ${MAX_POINTS}`);
  }

  let pivot = -1;
  for (let k = 2; k < sites.length; k++) {
    if (orient(sites[0], sites[1], sites[k]) !== 0n) {
      pivot = k;
      break;
    }
  }
  if (sites.length < 3 || pivot === -1) {
    return collinearResult(sites, indexBySource);
  }

  const n = sites.length;
  const xs = sites.map((s) => s.x);
  const ys = sites.map((s) => s.y);
  const minX = minBig(xs), maxX = maxBig(xs), minY = minBig(ys), maxY = maxBig(ys);
  const dx = maxX - minX || 1n;
  const dy = maxY - minY || 1n;
  const d = dx > dy ? dx * 20n + 100n : dy * 20n + 100n;
  const mx = (minX + maxX) / 2n;
  const my = (minY + maxY) / 2n;
  const superPts = [
    { x: mx - 20n * d, y: my - d },
    { x: mx + 20n * d, y: my - d },
    { x: mx, y: my + 20n * d },
  ];
  const P = (i: number) => (i < n ? sites[i] : superPts[i - n]);

  const tris: RTri[] = [];
  const mkTri = (a: number, b: number, c: number): RTri => {
    const o = orient(P(a), P(b), P(c));
    if (o === 0n) throw new Error('内部错误：产生零面积三角形');
    return { v: o > 0n ? [a, b, c] : [a, c, b], alive: true };
  };
  tris.push(mkTri(n, n + 1, n + 2));

  for (let idx = 0; idx < n; idx++) {
    const p = sites[idx];

    const bad: RTri[] = [];
    for (const t of tris) {
      if (!t.alive) continue;
      const [a, b, c] = t.v;
      if (inCircle(P(a), P(b), P(c), p) > 0n) {
        t.alive = false;
        bad.push(t);
      }
    }

    const edgeCount = new Map<string, { e: [number, number]; c: number }>();
    for (const t of bad) {
      const [a, b, c] = t.v;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const k = edgeKey(u, v);
        const rec = edgeCount.get(k);
        if (rec) rec.c++;
        else edgeCount.set(k, { e: [u, v], c: 1 });
      }
    }

    for (const rec of edgeCount.values()) {
      if (rec.c === 1) {
        tris.push(mkTri(rec.e[0], rec.e[1], idx));
      }
    }
  }

  const triangles: Tri[] = tris
    .filter((t) => t.alive && t.v.every((v) => v < n))
    .map((t) => ({ v: [...t.v] as [number, number, number] }));

  const { edgeTriangles, adjacency, hull } = buildTopology(sites.length, triangles);

  return { sites, indexBySource, triangles, hull, edgeTriangles, adjacency, degenerate: false };
}

function buildTopology(n: number, triangles: Tri[]) {
  const edgeTriangles = new Map<string, number[]>();
  const edgeDirected = new Map<string, [number, number]>();
  const neighSets = Array.from({ length: n }, () => new Set<number>());
  triangles.forEach((t, ti) => {
    const [a, b, c] = t.v;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = edgeKey(u, v);
      const arr = edgeTriangles.get(k);
      if (arr) arr.push(ti);
      else {
        edgeTriangles.set(k, [ti]);
        // 第一次出现时记录有向边；若最终为内部边则不使用
        edgeDirected.set(k, [u, v]);
      }
      neighSets[u].add(v);
      neighSets[v].add(u);
    }
  });

  const hullEdges = [...edgeTriangles.entries()]
    .filter(([, arr]) => arr.length === 1)
    .map(([k]) => edgeDirected.get(k)!);
  const hull = walkHull(hullEdges);

  const adjacency: NeighborInfo[] = neighSets.map((s, i) => ({
    siteIndex: i,
    neighbors: [...s].sort((a, b) => a - b),
  }));
  return { edgeTriangles, adjacency, hull };
}

function walkHull(edges: [number, number][]): number[] {
  if (edges.length === 0) return [];
  const next = new Map<number, number>();
  for (const [a, b] of edges) next.set(a, b);
  const start = edges[0][0];
  const ring = [start];
  let cur = next.get(start)!;
  const guard = edges.length + 1;
  let i = 0;
  while (cur !== start && i++ < guard) {
    ring.push(cur);
    cur = next.get(cur)!;
  }
  return ring;
}

function collinearResult(sites: Site[], indexBySource: Map<string, number>): TriangulationResult {
  const o = sites[0];
  const ref = sites[1] ?? sites[0];
  const dirX = ref.x - o.x, dirY = ref.y - o.y;
  const sorted = [...sites].sort((a, b) => {
    const ta = (a.x - o.x) * dirX + (a.y - o.y) * dirY;
    const tb = (b.x - o.x) * dirX + (b.y - o.y) * dirY;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const remap = new Map<number, number>();
  sorted.forEach((s, i) => remap.set(sites.indexOf(s), i));
  const chain = sorted.map((_, i) => i);
  const edgeTriangles = new Map<string, number[]>();
  const adjacency: NeighborInfo[] = sorted.map((_, i) => ({
    siteIndex: i,
    neighbors: [i - 1, i + 1].filter((j) => j >= 0 && j < sorted.length).sort((a, b) => a - b),
  }));
  for (let i = 0; i < chain.length - 1; i++) {
    edgeTriangles.set(edgeKey(chain[i], chain[i + 1]), []);
  }
  return {
    sites: sorted,
    indexBySource: remapIndex(indexBySource, remap),
    triangles: [],
    hull: chain,
    edgeTriangles,
    adjacency,
    degenerate: true,
    degenerateReason:
      sites.length < 3 ? `唯一位置仅 ${sites.length} 个，无法构成三角形` : '全部位置共线，无法构成三角形',
  };
}

function remapIndex(old: Map<string, number>, remap: Map<number, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [k, v] of old) m.set(k, remap.get(v)!);
  return m;
}

function emptyResult(sites: Site[], indexBySource: Map<string, number>, degenerate: boolean, reason: string): TriangulationResult {
  return {
    sites,
    indexBySource,
    triangles: [],
    hull: [],
    edgeTriangles: new Map(),
    adjacency: [],
    degenerate,
    degenerateReason: reason,
  };
}

function minBig(xs: bigint[]): bigint {
  return xs.reduce((m, v) => (v < m ? v : m));
}
function maxBig(xs: bigint[]): bigint {
  return xs.reduce((m, v) => (v > m ? v : m));
}
