import { GEOMETRY_TOLERANCE } from "../constants.js";
import type { Bounds, UniqueSite, VoronoiCell } from "../types.js";
import type { TriangulationResult } from "../types.js";
import { incircle, orient, type IPoint } from "./predicates.js";

export interface VerifyReport {
  ok: boolean;
  errors: string[];
  triangleCount: number;
  siteCount: number;
  hullArea2: string;
  triangleArea2Sum: string;
  voronoi?: {
    rectangleArea: number;
    cellAreaSum: number;
    areaError: number;
    sampleChecks: number;
    sampleFailures: number;
  };
}

function segmentsCross(a: IPoint, b: IPoint, c: IPoint, d: IPoint): boolean {
  // 共享端点不算交叉；共线重叠由 hull 面积覆盖与面重复检查间接约束，这里处理正常相交。
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 === 0n || o2 === 0n || o3 === 0n || o4 === 0n) return false;
  return (o1 > 0n) !== (o2 > 0n) && (o3 > 0n) !== (o4 > 0n);
}

/** 独立校验三角剖分。 */
export function verifyTriangulation(sites: UniqueSite[], tri: TriangulationResult): VerifyReport {
  const errors: string[] = [];
  const pts: IPoint[] = sites.map((s) => ({ x: s.x, y: s.y }));

  const faceKeys = new Set<string>();
  let areaSum = 0n;

  for (const t of tri.triangles) {
    const [a, b, c] = t.sites;
    const key = [a, b, c].sort((x, y) => x - y).join("-");
    if (faceKeys.has(key)) errors.push(`重复三角形面：${key}`);
    faceKeys.add(key);

    const o = orient(pts[a], pts[b], pts[c]);
    if (o <= 0n) errors.push(`三角形 ${key} 不是严格逆时针（o=${o}），可能退化`);
    areaSum += o;

    // 空外接圆：其余站点不得严格位于外接圆内（共圆允许）。
    for (let k = 0; k < pts.length; k++) {
      if (k === a || k === b || k === c) continue;
      const ic = incircle(pts[a], pts[b], pts[c], pts[k]);
      if (ic > 0n) {
        errors.push(`三角形 ${key} 的外接圆包含站点 ${k}（incircle=${ic}），违反空圆性质`);
      }
    }
  }

  // 交叉边检查（三角剖分的非相邻边不得相互穿越）。
  const edges = tri.edgeAdjacency.map((e) => e.edge);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
      if (segmentsCross(pts[e1.a], pts[e1.b], pts[e2.a], pts[e2.b])) {
        errors.push(`存在交叉边：(${e1.a},${e1.b}) 与 (${e2.a},${e2.b})`);
      }
    }
  }

  // 凸包面积覆盖：三角形有向面积之和必须等于凸包面积（精确 BigInt）。
  const hullArea = BigInt(tri.hullArea2);
  if (!tri.collinear && areaSum !== hullArea) {
    errors.push(`面积覆盖不一致：三角形有向面积 2x 和=${areaSum}，凸包 2x 面积=${hullArea}`);
  }

  // 内部点不得遗漏：每个站点必须在凸包内（边上或内部）。
  const hullPts = hullFromEdges(sites, tri);
  if (hullPts.length >= 3) {
    for (let k = 0; k < pts.length; k++) {
      if (!pointInOrOnPolygon(pts[k], hullPts)) {
        errors.push(`站点 ${k} 位于凸包之外，可能遗漏内部点`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    triangleCount: tri.triangles.length,
    siteCount: sites.length,
    hullArea2: tri.hullArea2,
    triangleArea2Sum: areaSum.toString(),
  };
}

function hullFromEdges(sites: UniqueSite[], tri: TriangulationResult): IPoint[] {
  // 将凸包边按邻接顺序串成 CCW 环。
  if (tri.hull.length < 3) return [];
  const adj = new Map<number, Set<number>>();
  for (const e of tri.hull) {
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
  }
  const pts: IPoint[] = [];
  let cur = tri.hull[0].a;
  const start = cur;
  let prev = -1;
  for (;;) {
    pts.push({ x: sites[cur].x, y: sites[cur].y });
    const nxt = [...(adj.get(cur) ?? [])].find((n) => n !== prev);
    if (nxt === undefined || nxt === start) break;
    prev = cur;
    cur = nxt;
  }
  return pts;
}

function pointInOrOnPolygon(p: IPoint, poly: IPoint[]): boolean {
  let hasNeg = false;
  let hasPos = false;
  for (let i = 0; i < poly.length; i++) {
    const o = orient(poly[i], poly[(i + 1) % poly.length], p);
    if (o > 0n) hasPos = true;
    if (o < 0n) hasNeg = true;
    if (hasPos && hasNeg) return false;
  }
  return true;
}

/** 校验裁剪 Voronoi：面积总和等于矩形面积；抽样点属于最近站点。 */
export function verifyVoronoi(
  sites: UniqueSite[],
  cells: VoronoiCell[],
  bounds: Bounds,
  tolerance = GEOMETRY_TOLERANCE,
): VerifyReport["voronoi"] & { errors: string[] } {
  const errors: string[] = [];
  const rectArea = (bounds.xmax - bounds.xmin) * (bounds.ymax - bounds.ymin);
  const cellAreaSum = cells.reduce((sum, c) => sum + c.area, 0);
  const areaError = Math.abs(cellAreaSum - rectArea);
  if (areaError > 1e-6 * Math.max(1, rectArea)) {
    errors.push(`单元面积和 ${cellAreaSum} 与矩形面积 ${rectArea} 偏差 ${areaError} 超出容差`);
  }

  // 在矩形内规则网格抽样：点必须落在其最近站点单元中（边界等距允许任意相邻单元）。
  let checks = 0;
  let failures = 0;
  const grid = 7;
  const cellBySite = new Map(cells.map((c) => [c.siteIndex, c]));
  for (let ix = 0; ix <= grid; ix++) {
    for (let iy = 0; iy <= grid; iy++) {
      const x = bounds.xmin + ((bounds.xmax - bounds.xmin) * (ix + 0.5)) / (grid + 1);
      const y = bounds.ymin + ((bounds.ymax - bounds.ymin) * (iy + 0.5)) / (grid + 1);
      checks++;

      let bestDist = Infinity;
      const bestSites: number[] = [];
      for (const s of sites) {
        const d = (x - s.x) ** 2 + (y - s.y) ** 2;
        if (d < bestDist - tolerance) {
          bestDist = d;
          bestSites.length = 0;
          bestSites.push(s.siteIndex);
        } else if (Math.abs(d - bestDist) <= tolerance) {
          bestSites.push(s.siteIndex);
        }
      }

      const holder = sites.find((s) => pointInPolygon({ x, y }, cellBySite.get(s.siteIndex)!.polygon));
      if (holder === undefined) {
        failures++;
        errors.push(`抽样点 (${x.toFixed(2)},${y.toFixed(2)}) 不属于任何单元`);
      } else if (!bestSites.includes(holder.siteIndex)) {
        failures++;
        errors.push(
          `抽样点 (${x.toFixed(2)},${y.toFixed(2)}) 属于站点 ${holder.siteIndex}，但最近站点为 ${bestSites.join("/")}`,
        );
      }
    }
  }

  return {
    rectangleArea: rectArea,
    cellAreaSum,
    areaError,
    sampleChecks: checks,
    sampleFailures: failures,
    errors,
  }

  function pointInPolygon(p: IPoint, poly: Array<{ x: number; y: number }>): boolean {
    if (poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const onLine =
        Math.abs((yj - yi) * (p.x - xi) - (xj - xi) * (p.y - yi)) <= 1e-7 &&
        p.x >= Math.min(xi, xj) - 1e-7 && p.x <= Math.max(xi, xj) + 1e-7 &&
        p.y >= Math.min(yi, yj) - 1e-7 && p.y <= Math.max(yi, yj) + 1e-7;
      if (onLine) return true;
      if (yi > p.y !== yj > p.y) {
        const crossX = xi + ((p.y - yi) * (xj - xi)) / (yj - yi);
        if (crossX > p.x) inside = !inside;
      }
    }
    return inside;
  }
}
