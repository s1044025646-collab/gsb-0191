import type { Edge, TriangulationResult, UniqueSite } from "../types.js";
import { allCollinear, convexHull } from "./hull.js";
import { incircle, orient, type IPoint } from "./predicates.js";

/**
 * 自行实现的 Delaunay 三角剖分（Bowyer–Watson 增量算法）。
 *
 * 确定性规则：
 *  - 站点按坐标字典序 (x,y) 插入（规范化站点序号），与用户编号无关；
 *  - “坏三角形”判定 incircle >= 0：共圆（=0）也删除，共圆情形因此收敛为
 *    “最后插入的站点作为扇形中心”这一确定且合法的 Delaunay 剖分；
 *  - 裁剪重连时跳过退化（共线）扇形三角形，等价于对经过新点的边做分裂。
 */

interface Tri {
  v: [number, number, number];
}

const SUPER_M = 10_000_000;

export function delaunay(sitesInput: UniqueSite[]): TriangulationResult {
  // 仅按坐标排序（siteIndex 已是该顺序），复制为 IPoint。
  const sites = [...sitesInput].sort((a, b) => a.siteIndex - b.siteIndex);
  const pts: IPoint[] = sites.map((s) => ({ x: s.x, y: s.y }));
  const n = sites.length;

  const base: TriangulationResult = {
    triangles: [],
    hull: [],
    edgeAdjacency: [],
    neighbors: Object.fromEntries(sites.map((s) => [s.siteIndex, []])),
    collinear: allCollinear(pts),
    hullArea2: "0",
  };

  if (n < 3 || base.collinear) {
    finalizeDegenerate(base, pts, sites.map((s) => s.siteIndex));
    return base;
  }

  // 超级三角形三个顶点索引 n, n+1, n+2（整数坐标）。
  pts.push({ x: -SUPER_M, y: -SUPER_M });
  pts.push({ x: SUPER_M, y: -SUPER_M });
  pts.push({ x: 0, y: SUPER_M });
  const s0 = n, s1 = n + 1, s2 = n + 2;

  let tris: Tri[] = [{ v: [s0, s1, s2] }];

  for (let p = 0; p < n; p++) {
    const badSet = findCavity(p, pts, tris);
    const bad = tris.filter((t) => badSet.has(t));

    // 收集洞边界：在坏三角形集合中仅出现一次的（无向）边即为空腔边界。
    const edgeMap = new Map<string, { u: number; v: number; count: number }>();
    const addEdge = (uRaw: number, vRaw: number) => {
      const u = Math.min(uRaw, vRaw);
      const v = Math.max(uRaw, vRaw);
      const k = `${u}|${v}`;
      const e = edgeMap.get(k);
      if (e) e.count++;
      else edgeMap.set(k, { u, v, count: 1 });
    };
    for (const t of bad) {
      const [a, b, c] = t.v;
      addEdge(a, b); addEdge(b, c); addEdge(c, a);
    }

    // 排序保证重连顺序（进而三角形列表顺序）确定。
    const boundary: Array<{ u: number; v: number }> = [];
    for (const e of edgeMap.values()) {
      if (e.count === 1) boundary.push({ u: e.u, v: e.v });
    }
    boundary.sort((e1, e2) => e1.u - e2.u || e1.v - e2.v);

    tris = tris.filter((t) => !badSet.has(t));

    for (const { u, v } of boundary) {
      // 跳过退化：p 恰好在边 uv 上（含超级边情形由后续过滤兜底）。
      if (orient(pts[p], pts[u], pts[v]) === 0n) continue;
      // 保证 (p,u,v) 为 CCW。
      if (orient(pts[p], pts[u], pts[v]) > 0n) {
        tris.push({ v: [p, u, v] });
      } else {
        tris.push({ v: [p, v, u] });
      }
    }
  }

  // 删除引用超级顶点的三角形，并统一 CCW。
  const finalTris: Tri[] = [];
  for (const t of tris) {
    if (t.v.some((v) => v >= n)) continue;
    const [a, b, c] = t.v;
    if (orient(pts[a], pts[b], pts[c]) > 0n) finalTris.push({ v: [a, b, c] });
    else finalTris.push({ v: [a, c, b] });
  }

  // 映射回规范化站点序号（此处索引与 siteIndex 一致，因为 sites 按 siteIndex 排序）。
  const triangles = finalTris.map((t) => ({
    sites: [t.v[0], t.v[1], t.v[2]] as [number, number, number],
  }));

  base.triangles = triangles;

  // 凸包（用精确单调链）。
  const hullIdx = convexHull(pts.slice(0, n));
  const hullEdges: Edge[] = [];
  if (hullIdx.length >= 3) {
    for (let i = 0; i < hullIdx.length; i++) {
      const a = hullIdx[i];
      const b = hullIdx[(i + 1) % hullIdx.length];
      hullEdges.push({ a: Math.min(a, b), b: Math.max(a, b) });
    }
  } else if (hullIdx.length === 2) {
    hullEdges.push({ a: Math.min(hullIdx[0], hullIdx[1]), b: Math.max(hullIdx[0], hullIdx[1]) });
  }
  base.hull = hullEdges;

  buildAdjacency(base);
  base.hullArea2 = hullAreaTwice(pts.slice(0, n), hullIdx).toString();
  return base;
}

/** 返回三角形的 CCW 顶点。 */
function ccwVerts(pts: IPoint[], t: Tri): [number, number, number] {
  const [a, b, c] = t.v;
  if (orient(pts[a], pts[b], pts[c]) < 0n) return [a, c, b];
  return [a, b, c];
}

/**
 * 确定插入点 p 的空腔（坏三角形集合）。
 *
 * 播种：
 *  - 若 p 在某三角形内（含边上），以该三角形为种子；
 *  - 否则（p 在当前凸包外）以所有“对 p 可见”的边界边所属三角形为种子。
 * 随后跨边泛洪：邻居外接圆满足 incircle >= 0（含共圆 =0）即纳入，
 * 使共圆多边形被整体挖开并以 p 为扇形中心重连，结果确定且合法。
 */
function findCavity(p: number, pts: IPoint[], tris: Tri[]): Set<Tri> {
  // 无向边 -> 拥有该边的三角形（1 个=边界边，2 个=内部边）。
  const edgeOwners = new Map<string, { edge: [number, number]; tris: Tri[] }>();
  const ek = (u: number, v: number) => (u < v ? `${u}|${v}` : `${v}|${u}`);
  for (const t of tris) {
    const [a, b, c] = ccwVerts(pts, t);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = ek(u, v);
      let rec = edgeOwners.get(key);
      if (!rec) {
        rec = { edge: [Math.min(u, v), Math.max(u, v)], tris: [] };
        edgeOwners.set(key, rec);
      }
      rec.tris.push(t);
    }
  }

  const seeds = new Set<Tri>();
  const containers: Tri[] = [];
  for (const t of tris) {
    const [a, b, c] = ccwVerts(pts, t);
    const inside =
      orient(pts[a], pts[b], pts[p]) >= 0n &&
      orient(pts[b], pts[c], pts[p]) >= 0n &&
      orient(pts[c], pts[a], pts[p]) >= 0n;
    if (inside) {
      containers.push(t);
    }
  }

  if (containers.length > 0) {
    // 点落在内部边上时会同时属于两个（共线时可能更多）三角形，全部作为种子；
    // 种子集合本身已确定（与顺序无关），泛洪结果只取决于几何。
    for (const t of containers) seeds.add(t);
  } else {
    // 凸包外：找可见边界边（边界边在其所属三角形 CCW 走向下，p 位于外侧）。
    for (const t of tris) {
      const [a, b, c] = ccwVerts(pts, t);
      const edges: Array<[number, number]> = [[a, b], [b, c], [c, a]];
      let visible = false;
      for (const [ru, rv] of edges) {
        // 无向记录：内部边有 2 个所属三角形，跳过。
        const rec = edgeOwners.get(ek(ru, rv));
        if (rec && rec.tris.length > 1) continue; // 内部边
        // 用该三角形的 CCW 方向 (ru,rv) 判断 p 是否在外侧。
        if (orient(pts[ru], pts[rv], pts[p]) < 0n) visible = true;
      }
      if (visible) seeds.add(t);
    }
  }

  const bad = new Set<Tri>(seeds);
  const stack = [...seeds];
  const processed = new Set<Tri>();
  while (stack.length) {
    const t = stack.pop()!;
    if (processed.has(t)) continue;
    processed.add(t);
    const [a, b, c] = ccwVerts(pts, t);
    const edges: Array<[number, number]> = [[a, b], [b, c], [c, a]];
    for (const [u, v] of edges) {
      const rec = edgeOwners.get(ek(u, v));
      if (!rec) continue;
      for (const neighbor of rec.tris) {
        if (bad.has(neighbor)) continue;
        if (neighbor === t) continue;
        const [na, nb, nc] = ccwVerts(pts, neighbor);
        if (incircle(pts[na], pts[nb], pts[nc], pts[p]) >= 0n) {
          bad.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
  }

  return bad;
}

function finalizeDegenerate(
  result: TriangulationResult,
  pts: IPoint[],
  siteOrder: number[],
): void {
  const hullIdx = convexHull(pts);
  if (hullIdx.length >= 3) {
    for (let i = 0; i < hullIdx.length; i++) {
      const a = siteOrder[hullIdx[i]];
      const b = siteOrder[(i + 1) % hullIdx.length];
      result.hull.push({ a: Math.min(a, b), b: Math.max(a, b) });
    }
    result.hullArea2 = hullAreaTwice(pts, hullIdx).toString();
  } else if (hullIdx.length === 2) {
    // 全共线：凸包退化为连接两端点的一条线段。
    const a = siteOrder[hullIdx[0]];
    const b = siteOrder[hullIdx[1]];
    result.hull.push({ a: Math.min(a, b), b: Math.max(a, b) });
  }
  // 共线时每个中间点的邻居为其两侧点（按线上次序），端点一个邻居。
  const sorted = pts
    .map((p, i) => ({ i, x: p.x, y: p.y }))
    .sort((p, q) => p.x - q.x || p.y - q.y)
    .map((o) => siteOrder[o.i]);
  sorted.forEach((s, i) => {
    const nb: number[] = [];
    if (i > 0) nb.push(sorted[i - 1]);
    if (i < sorted.length - 1) nb.push(sorted[i + 1]);
    result.neighbors[s] = nb.sort((a, b) => a - b);
  });
  for (const e of result.hull) {
    result.edgeAdjacency.push({ edge: e, triangles: [] });
  }
}

function buildAdjacency(result: TriangulationResult): void {
  const edgeToTris = new Map<string, number[]>();
  const ek = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  result.triangles.forEach((t, ti) => {
    const [a, b, c] = t.sites;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const k = ek(u, v);
      const arr = edgeToTris.get(k) ?? [];
      arr.push(ti);
      edgeToTris.set(k, arr);
    }
  });

  const neighbors: Record<number, Set<number>> = {};
  for (const t of result.triangles) {
    for (const v of t.sites) if (!neighbors[v]) neighbors[v] = new Set();
    const [a, b, c] = t.sites;
    neighbors[a].add(b); neighbors[a].add(c);
    neighbors[b].add(a); neighbors[b].add(c);
    neighbors[c].add(a); neighbors[c].add(b);
  }
  for (const k of Object.keys(neighbors)) {
    result.neighbors[Number(k)] = [...neighbors[Number(k)]].sort((a, b) => a - b);
  }

  result.edgeAdjacency = [...edgeToTris.entries()]
    .map(([k, triangles]) => {
      const [a, b] = k.split("|").map(Number);
      return { edge: { a, b }, triangles: triangles.sort((x, y) => x - y) };
    })
    .sort((e1, e2) => e1.edge.a - e2.edge.a || e1.edge.b - e2.edge.b);
}

function hullAreaTwice(pts: IPoint[], hullCCW: number[]): bigint {
  let area = 0n;
  for (let i = 0; i < hullCCW.length; i++) {
    const p = pts[hullCCW[i]];
    const q = pts[hullCCW[(i + 1) % hullCCW.length]];
    area += BigInt(p.x) * BigInt(q.y) - BigInt(q.x) * BigInt(p.y);
  }
  return area < 0n ? -area : area;
}
