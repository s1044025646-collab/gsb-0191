import { GEOMETRY_TOLERANCE } from "../constants.js";
import type { Bounds, TriangulationResult, UniqueSite, VoronoiCell } from "../types.js";

/**
 * 裁剪 Voronoi 单元。
 *
 * 站点 i 的单元 = 裁剪矩形 ∩ ⋂_{j 为 i 的 Delaunay 邻居} H(i,j)，
 * 其中 H(i,j) = { x : |x - Pi|² <= |x - Pj|² } 是垂直平分线朝向 i 的半平面。
 *
 * 与三角剖分邻接的关系：Voronoi 图是 Delaunay 三角剖分的直线对偶：
 *  - 每条 Delaunay 边对应一条 Voronoi 边（其垂直平分线上的一段）；
 *  - 每个 Delaunay 三角形对应一个 Voronoi 顶点（外接圆圆心）；
 *  - 因而裁剪某站点单元时，只需与该站点的 Delaunay 邻居求半平面交。
 *
 * 边界等距归属：tiePolicy = lower-site，即平分线上的点在归属判定中归
 * 站点序号较小者。半平面裁剪采用闭半平面，单元相邻处仅共享零面积边界。
 */

export interface VPoint {
  x: number;
  y: number;
}

export function voronoiCells(
  sites: UniqueSite[],
  tri: TriangulationResult,
  bounds: Bounds,
): VoronoiCell[] {
  const byIndex = new Map(sites.map((s) => [s.siteIndex, s]));

  return sites.map((site) => {
    const inside =
      site.x >= bounds.xmin &&
      site.x <= bounds.xmax &&
      site.y >= bounds.ymin &&
      site.y <= bounds.ymax;

    // 初始多边形：裁剪矩形（CCW）。
    let poly: VPoint[] = [
      { x: bounds.xmin, y: bounds.ymin },
      { x: bounds.xmax, y: bounds.ymin },
      { x: bounds.xmax, y: bounds.ymax },
      { x: bounds.xmin, y: bounds.ymax },
    ];

    const neighbors = tri.neighbors[site.siteIndex] ?? [];
    for (const j of neighbors) {
      const other = byIndex.get(j)!;
      poly = clipHalfPlane(poly, site, other);
      if (poly.length < 3) break;
    }

    // 数值清理：合并过近顶点。
    poly = simplify(poly);
    const empty = poly.length < 3;
    const area = empty ? 0 : polygonArea(poly);

    return {
      siteIndex: site.siteIndex,
      polygon: empty ? [] : poly,
      area: Math.abs(area),
      empty,
      siteInsideBounds: inside,
    };
  });
}

/**
 * Sutherland–Hodgman：用半平面 |x - p|² <= |x - q|² 裁剪多边形。
 * 化简为 2*x·(q-p) <= |q|² - |p|²。
 */
function clipHalfPlane(poly: VPoint[], p: UniqueSite, q: UniqueSite): VPoint[] {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const c = (q.x * q.x + q.y * q.y - p.x * p.x - p.y * p.y) / 2;

  const inside = (v: VPoint) => v.x * dx + v.y * dy <= c + GEOMETRY_TOLERANCE;
  const out: VPoint[] = [];
  if (poly.length === 0) return out;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ain = inside(a);
    const bin = inside(b);
    const fa = a.x * dx + a.y * dy - c;
    const fb = b.x * dx + b.y * dy - c;

    if (ain && bin) {
      out.push(b);
    } else if (ain && !bin) {
      out.push(intersect(a, b, fa, fb));
    } else if (!ain && bin) {
      out.push(intersect(a, b, fa, fb));
      out.push(b);
    }
  }
  return out;
}

function intersect(a: VPoint, b: VPoint, fa: number, fb: number): VPoint {
  const denom = fa - fb;
  if (Math.abs(denom) < GEOMETRY_TOLERANCE) return { x: b.x, y: b.y };
  const t = fa / denom; // a 处值 fa，b 处值 fb，零点参数
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function simplify(poly: VPoint[]): VPoint[] {
  const out: VPoint[] = [];
  for (const v of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(v.x - last.x, v.y - last.y) > GEOMETRY_TOLERANCE) {
      out.push(v);
    }
  }
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= GEOMETRY_TOLERANCE) {
      out.pop();
    }
  }
  return out;
}

function polygonArea(poly: VPoint[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
