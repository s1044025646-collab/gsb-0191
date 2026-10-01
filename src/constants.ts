/**
 * 全局常量与公开限制。
 *
 * 坐标为整数（平面欧氏坐标），范围与点数上限在此显式公开并强制执行。
 */
export const COORD_MIN = -1_000_000;
export const COORD_MAX = 1_000_000;

/** 单次构网允许的“来源点”数量上限。 */
export const MAX_POINTS = 5000;

/**
 * 浮点几何容差（输出时随结果报告）。
 * 精确谓词全部使用 BigInt，不参与该容差；该容差仅用于：
 *  - Voronoi 半平面求交的数值裁剪
 *  - 顶点/面积的浮点结果去重与判零
 */
export const GEOMETRY_TOLERANCE = 1e-9;

/** 半平面求交前的初始包围盒（远大于合法裁剪矩形即可）。 */
export const CLIP_HALFPLANE_BOUND = 1e7;
