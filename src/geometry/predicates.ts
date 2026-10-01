/**
 * 精确几何谓词，全部使用 BigInt，避免浮点方向/共圆误判。
 * 输入坐标为整数；super-triangle 使用的坐标也限定为整数。
 */

export interface IPoint {
  x: number;
  y: number;
}

/** orient2d：>0 表示 a->b->c 逆时针，=0 共线，<0 顺时针。 */
export function orient(a: IPoint, b: IPoint, c: IPoint): bigint {
  const ax = BigInt(a.x), ay = BigInt(a.y);
  const bx = BigInt(b.x), by = BigInt(b.y);
  const cx = BigInt(c.x), cy = BigInt(c.y);
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * incircle：点 d 在三角形 abc 的外接圆内（abc 需按 CCW 给出）。
 * 返回 >0 在内，=0 共圆，<0 在外。
 * 注意：标准 4x4 行列式的“圆内为正”与 abc 绕序无关（交换两列与对应行
 * 同时变号，整体不变），因此不得再按 orient 人为取反。
 */
export function incircle(a: IPoint, b: IPoint, c: IPoint, d: IPoint): bigint {
  const ax = BigInt(a.x), ay = BigInt(a.y);
  const bx = BigInt(b.x), by = BigInt(b.y);
  const cx = BigInt(c.x), cy = BigInt(c.y);
  const dx = BigInt(d.x), dy = BigInt(d.y);

  const adx = ax - dx, ady = ay - dy;
  const bdx = bx - dx, bdy = by - dy;
  const cdx = cx - dx, cdy = cy - dy;

  const al = adx * adx + ady * ady;
  const bl = bdx * bdx + bdy * bdy;
  const cl = cdx * cdx + cdy * cdy;

  const det =
    adx * (bdy * cl - bl * cdy) -
    ady * (bdx * cl - bl * cdx) +
    al * (bdx * cdy - bdy * cdx);

  return det;
}

export function ccw(a: IPoint, b: IPoint, c: IPoint): boolean {
  return orient(a, b, c) > 0n;
}
