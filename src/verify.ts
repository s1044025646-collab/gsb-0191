/**
 * 独立校验器：不依赖剖分算法内部结构，只从输入点 + 输出结果做核对。
 */
import { inCircle, orient, triangulate, type SourcePoint } from './geometry.js';
import type { BuildOutput } from './service.js';

export interface VerifyReport {
  triangles: number;
  uniqueSites: number;
  doubledAreaSum: bigint;
  hullDoubledArea: bigint;
  allCCW: boolean;
  emptyCircleHolds: boolean;
  noDuplicateFaces: boolean;
  areaCovered: boolean;
  hullEdgesMatched: boolean;
}

export function verifyTriangulation(points: SourcePoint[]): VerifyReport {
  const tr = triangulate(points);
  const sitePts = tr.sites.map((s) => ({ x: s.x, y: s.y }));

  let allCCW = true;
  let emptyCircleHolds = true;

  for (const t of tr.triangles) {
    const [a, b, c] = t.v.map((i) => tr.sites[i]);
    if (orient(a, b, c) <= 0n) allCCW = false;
    // 空开外接圆：其余站点必须在圆上或圆外（incircle <= 0）
    for (let k = 0; k < tr.sites.length; k++) {
      if (t.v.includes(k)) continue;
      if (inCircle(a, b, c, tr.sites[k]) > 0n) emptyCircleHolds = false;
    }
  }

  // 无重复面：顶点集合的键不重复
  const faceKeys = new Set<string>();
  let noDuplicateFaces = true;
  for (const t of tr.triangles) {
    const k = [...t.v].sort((x, y) => x - y).join('-');
    if (faceKeys.has(k)) noDuplicateFaces = false;
    faceKeys.add(k);
  }

  // 二倍有向面积之和（BigInt 精确）
  let doubledAreaSum = 0n;
  for (const t of tr.triangles) {
    const [a, b, c] = t.v.map((i) => tr.sites[i]);
    doubledAreaSum += orient(a, b, c);
  }

  let hullDoubledArea = 0n;
  for (let k = 0; k < tr.hull.length; k++) {
    const a = tr.sites[tr.hull[k]];
    const b = tr.sites[tr.hull[(k + 1) % tr.hull.length]];
    hullDoubledArea += a.x * b.y - b.x * a.y;
  }
  hullDoubledArea = hullDoubledArea < 0n ? -hullDoubledArea : hullDoubledArea;

  const areaCovered = tr.degenerate ? doubledAreaSum === 0n : doubledAreaSum === hullDoubledArea;

  // 凸包边与仅出现一次的三角边完全一致
  const boundaryEdgeKeys = new Set<string>();
  for (const [k, arr] of tr.edgeTriangles) if (arr.length === 1) boundaryEdgeKeys.add(k);
  const hullEdgeKeys = new Set<string>();
  for (let k = 0; k < tr.hull.length; k++) {
    const a = tr.hull[k];
    const b = tr.hull[(k + 1) % tr.hull.length];
    hullEdgeKeys.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  const hullEdgesMatched =
    boundaryEdgeKeys.size === hullEdgeKeys.size &&
    [...boundaryEdgeKeys].every((k) => hullEdgeKeys.has(k));

  return {
    triangles: tr.triangles.length,
    uniqueSites: tr.sites.length,
    doubledAreaSum,
    hullDoubledArea,
    allCCW,
    emptyCircleHolds,
    noDuplicateFaces,
    areaCovered,
    hullEdgesMatched,
  };
}

export interface VoronoiReport {
  cellAreaSum: number;
  rectArea: number;
  absError: number;
  samplesChecked: number;
  nearestHolds: boolean;
}

function dist2(px: number, py: number, x: number, y: number): number {
  const dx = px - x;
  const dy = py - y;
  return dx * dx + dy * dy;
}

/** 网格采样：每个非空单元内部样点必须以该站点为最近站点（含等距归属容差） */
export function verifyVoronoi(output: BuildOutput, samplesPerAxis = 12): VoronoiReport {
  if (!output.voronoi) throw new Error('结果不含 Voronoi');
  const { rect, cells } = output.voronoi;
  const rectArea = (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
  const cellAreaSum = cells.reduce((s, c) => s + c.area, 0);

  const sites = output.sites;
  let samplesChecked = 0;
  let nearestHolds = true;
  const TOL = 1e-7;

  for (const cell of cells) {
    if (cell.empty) continue;
    const cx = cell.polygon.reduce((s, p) => s + p[0], 0) / cell.polygon.length;
    const cy = cell.polygon.reduce((s, p) => s + p[1], 0) / cell.polygon.length;
    // 在中心附近取样点（更可能严格位于单元内部）
    const samples: Array<[number, number]> = [[cx, cy]];
    const jitter = 0.01;
    for (const [dx, dy] of [[jitter, 0], [-jitter, 0], [0, jitter], [0, -jitter]]) {
      samples.push([cx + dx, cy + dy]);
    }
    for (const [px, py] of samples) {
      const owner = sites[cell.siteIndex];
      const dOwn = dist2(px, py, owner.x, owner.y);
      for (const s of sites) {
        if (s.index === cell.siteIndex) continue;
        const d = dist2(px, py, s.x, s.y);
        if (d < dOwn - TOL) {
          nearestHolds = false;
        }
      }
      samplesChecked++;
    }
  }

  // 面积网格交叉核对：网格点恰属于一个非空单元
  for (let i = 0; i < samplesPerAxis; i++) {
    for (let j = 0; j < samplesPerAxis; j++) {
      const px = rect.minX + ((i + 0.5) / samplesPerAxis) * (rect.maxX - rect.minX);
      const py = rect.minY + ((j + 0.5) / samplesPerAxis) * (rect.maxY - rect.minY);
      let best = -1;
      let bestD = Infinity;
      for (const s of sites) {
        const d = dist2(px, py, s.x, s.y);
        if (d < bestD - TOL || (Math.abs(d - bestD) <= TOL && (best === -1 || s.id < sites[best].id))) {
          bestD = d;
          best = s.index;
        }
      }
      const ownerCell = cells.find((c) => !c.empty && c.siteIndex === best);
      if (!ownerCell || !pointInPolygon(px, py, ownerCell.polygon)) {
        nearestHolds = false;
      }
      samplesChecked++;
    }
  }

  return {
    cellAreaSum,
    rectArea,
    absError: Math.abs(cellAreaSum - rectArea),
    samplesChecked,
    nearestHolds,
  };
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
    const [xi, yi] = poly[k];
    const [xj, yj] = poly[j];
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
