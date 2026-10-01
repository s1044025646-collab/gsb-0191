import type { IPoint } from "./predicates.js";
import { orient } from "./predicates.js";

/**
 * Andrew 单调链凸包（精确谓词）。
 * 返回 CCW 顺序的凸包顶点索引。全共线时返回两个端点。
 */
export function convexHull(points: IPoint[]): number[] {
  if (points.length === 1) return [0];

  const order = points
    .map((p, i) => ({ i, x: p.x, y: p.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.i - b.i);
  const idx = order.map((o) => o.i);

  const cross = (i: number, j: number, k: number) =>
    orient(points[i], points[j], points[k]);

  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0n) {
      lower.pop();
    }
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0n) {
      upper.pop();
    }
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 所有站点是否共线（一点或两点也视为共线）。 */
export function allCollinear(points: IPoint[]): boolean {
  if (points.length <= 2) return true;
  const a = points[0];
  let b = points.find((p) => p.x !== a.x || p.y !== a.y);
  if (!b) return true; // 理论上不会发生（已去重），保险处理
  return points.every((p) => orient(a, b!, p) === 0n);
}
