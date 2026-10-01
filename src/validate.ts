import { COORD_MAX, COORD_MIN, MAX_POINTS } from "./constants.js";
import type { Bounds, SourcePoint, UniqueSite } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** 校验一批来源点，返回规范化（去空白 id、保持导入顺序）后的点。 */
export function validatePoints(raw: unknown): SourcePoint[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError("点集必须是数组");
  }
  if (raw.length === 0) {
    throw new ValidationError("点集不能为空");
  }
  if (raw.length > MAX_POINTS) {
    throw new ValidationError(`点数超过上限：${raw.length} > ${MAX_POINTS}`);
  }

  const seen = new Set<string>();
  const out: SourcePoint[] = [];

  raw.forEach((item, i) => {
    if (item === null || typeof item !== "object") {
      throw new ValidationError(`第 ${i} 项不是对象`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.trim() === "") {
      throw new ValidationError(`第 ${i} 项缺少非空字符串 id`);
    }
    const id = rec.id.trim();
    if (seen.has(id)) {
      throw new ValidationError(`来源编号重复：${id}`);
    }
    if (!isSafeInt(rec.x) || !isSafeInt(rec.y)) {
      throw new ValidationError(`点 ${id} 的坐标必须是整数`);
    }
    if (rec.x < COORD_MIN || rec.x > COORD_MAX || rec.y < COORD_MIN || rec.y > COORD_MAX) {
      throw new ValidationError(
        `点 ${id} 的坐标超出允许范围 [${COORD_MIN}, ${COORD_MAX}]`,
      );
    }
    seen.add(id);
    out.push({ id, x: rec.x, y: rec.y });
  });

  return out;
}

/** 校验裁剪矩形：必须整数、严格正面积。 */
export function validateBounds(raw: unknown): Bounds {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("裁剪矩形必须是对象");
  }
  const b = raw as Record<string, unknown>;
  for (const key of ["xmin", "ymin", "xmax", "ymax"] as const) {
    if (!isSafeInt(b[key])) {
      throw new ValidationError(`裁剪矩形字段 ${key} 必须是整数`);
    }
  }
  const { xmin, ymin, xmax, ymax } = b as unknown as Bounds;
  for (const v of [xmin, ymin, xmax, ymax]) {
    if (v < COORD_MIN || v > COORD_MAX) {
      throw new ValidationError(`裁剪矩形坐标超出允许范围 [${COORD_MIN}, ${COORD_MAX}]`);
    }
  }
  if (xmax <= xmin || ymax <= ymin) {
    throw new ValidationError("裁剪矩形面积必须严格为正（要求 xmax > xmin 且 ymax > ymin），拒绝零面积/倒置矩形");
  }
  return { xmin, ymin, xmax, ymax };
}

/**
 * 去重并构建规范化站点。
 * 站点序号按坐标字典序 (x, y) 分配，重复坐标的全部来源编号按导入顺序保留。
 */
export function deduplicate(points: SourcePoint[]): UniqueSite[] {
  const byCoord = new Map<string, UniqueSite>();
  for (const p of points) {
    const key = `${p.x},${p.y}`;
    let site = byCoord.get(key);
    if (!site) {
      site = { siteIndex: -1, x: p.x, y: p.y, sourceIds: [] };
      byCoord.set(key, site);
    }
    site.sourceIds.push(p.id);
  }
  const sites = [...byCoord.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  sites.forEach((s, i) => {
    s.siteIndex = i;
  });
  return sites;
}
