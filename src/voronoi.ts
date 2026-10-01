/**
 * 矩形裁剪 Voronoi 单元：
 * 从裁剪矩形出发，依次与“站点 i 相对站点 j 的更近半平面”求交。
 * 与三角剖分的关系：真正起约束作用的站点 j 恰好是 i 的 Delaunay 邻居；
 * 为稳健起见这里对全部站点裁剪（O(n^2)/单元），同时用邻接表做标注。
 *
 * 等距边界归属（确定性规则）：
 *   边界平分线上的等距点归“主来源编号字典序较小”的站点；
 *   故 i 的半平面在并列时，仅当 i 的 id 字典序更小时包含边界（闭半平面），
 *   否则取开半平面（数值上减去 EPS）。
 */

import type { TriangulationResult } from './geometry.js';

export const GEOMETRIC_TOLERANCE = 1e-9;

export interface ClipRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface VoronoiCell {
  siteIndex: number;
  sourceIds: string[];
  /** 裁剪后多边形顶点（顺时针/逆时针与裁剪一致），单元为空时为 [] */
  polygon: Array<[number, number]>;
  area: number;
  empty: boolean;
  /** 真正影响该单元边界的相邻站点（Delaunay 邻居子集） */
  boundedBy: number[];
}

interface Pt {
  x: number;
  y: number;
  id?: string;
}

/** 2*((j-i)·q) <= |j|^2-|i|^2 表示 q 距 i 不比距 j 远 */
function clipHalfPlane(
  poly: Pt[],
  i: Pt,
  j: Pt,
  includeBoundary: boolean,
): Pt[] {
  if (poly.length === 0) return poly;
  const a = 2 * (j.x - i.x);
  const b = 2 * (j.y - i.y);
  const c = j.x * j.x + j.y * j.y - i.x * i.x - i.y * i.y;
  const slack = includeBoundary ? GEOMETRIC_TOLERANCE : -GEOMETRIC_TOLERANCE;
  const val = (p: Pt) => a * p.x + b * p.y - c;

  const out: Pt[] = [];
  const inside = (v: number) => (includeBoundary ? v <= slack : v < slack);

  for (let k = 0; k < poly.length; k++) {
    const s = poly[k];
    const e = poly[(k + 1) % poly.length];
    const vs = val(s);
    const ve = val(e);
    const sin = inside(vs);
    const ein = inside(ve);
    if (sin && ein) {
      out.push(e);
    } else if (sin && !ein) {
      const t = vs / (vs - ve);
      out.push({ x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t });
    } else if (!sin && ein) {
      const t = vs / (vs - ve);
      out.push({ x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t });
      out.push(e);
    }
  }
  return out;
}

export function validateRect(r: ClipRect): string | null {
  const nums = [r.minX, r.minY, r.maxX, r.maxY];
  if (nums.some((v) => !Number.isFinite(v))) return '裁剪矩形坐标必须为有限数值';
  if (r.maxX <= r.minX || r.maxY <= r.minY) {
    return `零面积或反向裁剪矩形：minX=${r.minX},minY=${r.minY},maxX=${r.maxX},maxY=${r.maxY}`;
  }
  for (const v of nums) {
    if (Math.abs(v) > Number(1_000_001)) return '裁剪矩形超出允许坐标范围 [-1000000, 1000000]';
  }
  return null;
}

export function buildCells(tr: TriangulationResult, rect: ClipRect): VoronoiCell[] {
  const err = validateRect(rect);
  if (err) throw new Error(err);

  const base: Pt[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];

  return tr.sites.map((rawSite, i) => {
    const site: Pt = { x: Number(rawSite.x), y: Number(rawSite.y), id: rawSite.id };
    let poly = base.map((p) => ({ ...p }));
    const boundedBy = new Set<number>();
    for (let j = 0; j < tr.sites.length; j++) {
      if (j === i) continue;
      const other: Pt = { x: Number(tr.sites[j].x), y: Number(tr.sites[j].y) };
      const includeBoundary = (site.id ?? '') <= (other.id ?? '');
      const before = poly.length;
      poly = clipHalfPlane(poly, site, other, includeBoundary);
      if (poly.length === 0) break;
      if (poly.length !== before || poly.length < 4) boundedBy.add(j);
    }

    const polygon = poly.map((p) => [p.x, p.y] as [number, number]);
    const area = polygonArea(polygon);
    const empty = polygon.length < 3 || area < 1e-10;
    if (empty) polygon.length = 0;
    return {
      siteIndex: i,
      sourceIds: rawSite.sourceIds,
      polygon: empty ? [] : polygon,
      area: empty ? 0 : area,
      empty,
      boundedBy: [...boundedBy].filter((j) => tr.adjacency[i]?.neighbors.includes(j)).sort((a, b) => a - b),
    };
  });
}

export function polygonArea(poly: Array<[number, number]>): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let k = 0; k < poly.length; k++) {
    const [x1, y1] = poly[k];
    const [x2, y2] = poly[(k + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
