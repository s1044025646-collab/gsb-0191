/**
 * 核心数据类型。
 *
 * “来源点”是用户导入的记录：拥有唯一编号 id，坐标为整数，允许重复坐标。
 * “唯一站点（site）”是去重后的几何点，拥有稳定的规范化站点序号。
 */

export interface SourcePoint {
  /** 用户提供的唯一编号（非空字符串，去空白后比较）。 */
  id: string;
  x: number;
  y: number;
}

export interface UniqueSite {
  /** 规范化站点序号：坐标 (x,y) 按字典序排序后从 0 开始。 */
  siteIndex: number;
  x: number;
  y: number;
  /** 该坐标位置对应的全部来源编号（按导入顺序保留）。 */
  sourceIds: string[];
}

/** 轴对齐裁剪矩形（整数坐标）。 */
export interface Bounds {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** 算法配置。 */
export interface AlgoConfig {
  /**
   * 退化处理规则标识。当前固定为 canonical：
   * 按坐标字典序确定插入顺序与共圆打破规则，保证几何结果不依赖导入编号。
   */
  degeneracyPolicy: "canonical";
  /** Voronoi 边界等距点归属：lower-site（站点序号较小者），保持闭单元划分。 */
  bisectorTiePolicy: "lower-site";
}

export const DEFAULT_CONFIG: AlgoConfig = {
  degeneracyPolicy: "canonical",
  bisectorTiePolicy: "lower-site",
};

export interface PointSet {
  id: number;
  name: string;
  createdAt: string;
  points: SourcePoint[];
}

export interface Triangle {
  /** 统一为逆时针（CCW），存储唯一站点序号。 */
  sites: [number, number, number];
}

export interface Edge {
  /** 无向边，端点站点序号，a < b。 */
  a: number;
  b: number;
}

export interface TriangulationResult {
  triangles: Triangle[];
  /** 凸包边（CCW 环，含全共线时的退化线段表示）。 */
  hull: Edge[];
  /** 每条内部边的两侧三角形索引；边界边只含一个。 */
  edgeAdjacency: Array<{ edge: Edge; triangles: number[] }>;
  /** 每个站点的 Delaunay 邻居站点序号（升序）。 */
  neighbors: Record<number, number[]>;
  /** 是否全部站点共线（此时 triangles 为空）。 */
  collinear: boolean;
  /** 凸包面积的 2 倍（BigInt 精确值，字符串化输出）。 */
  hullArea2: string;
}

export interface VoronoiCell {
  siteIndex: number;
  /** 裁剪后多边形顶点（CCW，浮点坐标）；为空表示空单元。 */
  polygon: Array<{ x: number; y: number }>;
  /** 多边形面积（带符号约定：空单元为 0）。 */
  area: number;
  /** 单元是否为空（例如站点位于裁剪矩形外）。 */
  empty: boolean;
  /** 该站点坐标是否落在裁剪矩形内部/边界上。 */
  siteInsideBounds: boolean;
}
