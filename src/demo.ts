import { compute, compareNeighborhoods, type ComputePayload } from "./service.js";
import { exportCsv, exportJson } from "./exporters.js";
import { validateBounds, validatePoints, ValidationError } from "./validate.js";
import { verifyTriangulation, verifyVoronoi } from "./geometry/verify.js";
import { deduplicate } from "./validate.js";

function heading(s: string): void {
  process.stdout.write(`\n=== ${s} ===\n`);
}

function summarize(p: ComputePayload): void {
  process.stdout.write(
    [
      `来源点数: ${p.input.pointCount}, 唯一站点: ${p.input.uniqueSiteCount}`,
      `重复坐标: ${p.input.duplicates.length} 组`,
      `三角形数: ${p.triangulation.triangles.length}, 凸包边: ${p.triangulation.hull.length}`,
      `全共线: ${p.triangulation.collinear}, 凸包2x面积: ${p.triangulation.hullArea2}`,
      `Voronoi 单元面积和: ${p.voronoi.reduce((s, c) => s + c.area, 0).toFixed(6)}`,
      `几何容差: ${p.tolerance}`,
    ].join("\n") + "\n",
  );
}

function tryReject(label: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`[意外] ${label} 未被拒绝\n`);
  } catch (e) {
    const msg = e instanceof ValidationError ? e.message : String(e);
    process.stdout.write(`[已拒绝] ${label} -> ${msg}\n`);
  }
}

// 1) 导入：正方形 4 点 + 中心 1 点，另有两个重复坐标的不同来源编号。
heading("1. 导入点集（含中心点与重复位置）");
const points = [
  { id: "A", x: 0, y: 0 },
  { id: "B", x: 4, y: 0 },
  { id: "C", x: 4, y: 4 },
  { id: "D", x: 0, y: 4 },
  { id: "E", x: 2, y: 2 },
  { id: "A-dup-loc-1", x: 0, y: 0 },
];
const bounds = { xmin: -1, ymin: -1, xmax: 5, ymax: 5 };
const before = compute(points, bounds);
summarize(before);
process.stdout.write(`重复坐标 (0,0) 来源编号: ${before.input.duplicates[0]?.sourceIds.join(", ")}\n`);
process.stdout.write(`三角形(站点序号): ${before.triangulation.triangles.map((t) => `(${t.sites.join(",")})`).join(" ")}\n`);

// 2) 构网校验
heading("2. 独立校验");
const sitesBefore = deduplicate(points);
const tv = verifyTriangulation(sitesBefore, before.triangulation);
const vv = verifyVoronoi(sitesBefore, before.voronoi, bounds);
process.stdout.write(
    `三角剖分校验: ${tv.ok ? "通过" : "失败 " + tv.errors.join("; ")} ` +
    `(三角形2x面积和=${tv.triangleArea2Sum}, 凸包2x面积=${tv.hullArea2})\n`,
);
process.stdout.write(
  `Voronoi 校验: ${vv.errors.length === 0 ? "通过" : "失败 " + vv.errors.join("; ")} ` +
  `(单元面积和=${vv.cellAreaSum.toFixed(9)}, 矩形面积=${vv.rectangleArea}, 抽样=${vv.sampleChecks}, 失败=${vv.sampleFailures})\n`,
);

// 3) 插入一个新点并比较受影响邻域
heading("3. 插入新点 F=(3,1) 后比较邻域");
const afterPoints = [...points, { id: "F", x: 3, y: 1 }];
const after = compute(afterPoints, bounds);
summarize(after);
const diff = compareNeighborhoods(before, after);
process.stdout.write(`新增点: ${diff.addedPoints.map((p) => `${p.id}(${p.x},${p.y})`).join(", ")}\n`);
process.stdout.write(`受影响站点: ${diff.changedSites.join(", ")}\n`);
process.stdout.write(`新增邻居边: ${diff.addedNeighborEdges.map((e) => e.join("-")).join(" ") || "(无)"}\n`);
process.stdout.write(`删除邻居边: ${diff.removedNeighborEdges.map((e) => e.join("-")).join(" ") || "(无)"}\n`);

// 4) 幂等性说明：相同输入重复 compute 得到相同几何
heading("4. 共圆确定性（正方形，无中心）");
const square = [
  { id: "p1", x: 0, y: 0 },
  { id: "p2", x: 2, y: 0 },
  { id: "p3", x: 2, y: 2 },
  { id: "p4", x: 0, y: 2 },
];
const sq1 = compute(square, { xmin: 0, ymin: 0, xmax: 2, ymax: 2 });
const reordered = [square[3], square[1], square[0], square[2]];
const sq2 = compute(reordered, { xmin: 0, ymin: 0, xmax: 2, ymax: 2 });
process.stdout.write(`编号/导入顺序改变后三角形相同: ${JSON.stringify(sq1.triangulation) === JSON.stringify(sq2.triangulation)}\n`);
process.stdout.write(`正方形共圆三角形: ${sq1.triangulation.triangles.map((t) => `(${t.sites.join(",")})`).join(" ")}\n`);

// 5) 共线输入实际输出
heading("5. 全共线输入的实际输出");
const line = [
  { id: "l1", x: 0, y: 0 },
  { id: "l2", x: 2, y: 2 },
  { id: "l3", x: 5, y: 5 },
  { id: "l4", x: 1, y: 1 },
];
const lineRes = compute(line, { xmin: -1, ymin: -1, xmax: 6, ymax: 6 });
process.stdout.write(
  `collinear=${lineRes.triangulation.collinear}, 三角形数=${lineRes.triangulation.triangles.length}, ` +
  `凸包边=${JSON.stringify(lineRes.triangulation.hull)}, 邻接=${JSON.stringify(lineRes.triangulation.neighbors)}\n`,
);

// 6) 导出片段
heading("6. JSON / CSV 导出示例（插入后结果）");
process.stdout.write(`[JSON 片段] 前 200 字符:\n${exportJson(after).slice(0, 200)}...\n`);
const csv = exportCsv(after);
process.stdout.write(`[CSV triangles]\n${csv.triangles}\n`);

// 7) 非法输入拒绝原因
heading("7. 非法输入拒绝");
tryReject("非整数坐标", () => validatePoints([{ id: "x", x: 1.5, y: 0 }]));
tryReject("坐标越界", () => validatePoints([{ id: "x", x: 2_000_000, y: 0 }]));
tryReject("重复来源编号", () => validatePoints([{ id: "x", x: 0, y: 0 }, { id: "x", x: 1, y: 1 }]));
tryReject("空点集", () => validatePoints([]));
tryReject("零面积裁剪矩形", () => validateBounds({ xmin: 0, ymin: 0, xmax: 0, ymax: 5 }));
tryReject("倒置裁剪矩形", () => validateBounds({ xmin: 5, ymin: 5, xmax: 0, ymax: 0 }));
tryReject("矩形坐标非整数", () => validateBounds({ xmin: 0, ymin: 0, xmax: 2.5, ymax: 5 }));
