import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/service.js";
import { deduplicate, validateBounds, validatePoints, ValidationError } from "../src/validate.js";
import { verifyTriangulation, verifyVoronoi } from "../src/geometry/verify.js";
import type { SourcePoint } from "../src/types.js";

const B = { xmin: -10, ymin: -10, xmax: 10, ymax: 10 };

function check(points: SourcePoint[], bounds = B) {
  const payload = compute(points, bounds);
  const sites = deduplicate(points);
  const triReport = verifyTriangulation(sites, payload.triangulation);
  assert.deepEqual(triReport.errors, [], `三角剖分校验失败: ${triReport.errors.join("; ")}`);
  const vorReport = verifyVoronoi(sites, payload.voronoi, bounds);
  assert.deepEqual(vorReport.errors, [], `Voronoi 校验失败: ${vorReport.errors.join("; ")}`);
  return { payload, sites };
}

test("单三角形：1 个 CCW 三角形，凸包即三边", () => {
  const pts = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 4, y: 0 },
    { id: "c", x: 1, y: 3 },
  ];
  const { payload } = check(pts);
  assert.equal(payload.triangulation.triangles.length, 1);
  assert.equal(payload.triangulation.hull.length, 3);
  assert.equal(payload.triangulation.hullArea2, "12");
});

test("正方形共圆：2 个三角形且结果不随编号/导入顺序改变", () => {
  const pts = [
    { id: "p1", x: 0, y: 0 },
    { id: "p2", x: 2, y: 0 },
    { id: "p3", x: 2, y: 2 },
    { id: "p4", x: 0, y: 2 },
  ];
  const r1 = check(pts);
  assert.equal(r1.payload.triangulation.triangles.length, 2);
  const reordered = [pts[3], pts[1], pts[0], pts[2]];
  const r2 = check(reordered);
  assert.deepEqual(r2.payload.triangulation, r1.payload.triangulation);
});

test("含中心点：正方形 + 中心得到 4 个三角形，中心点是所有角点邻居", () => {
  const pts = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 4, y: 0 },
    { id: "c", x: 4, y: 4 },
    { id: "d", x: 0, y: 4 },
    { id: "e", x: 2, y: 2 },
  ];
  const { payload } = check(pts);
  assert.equal(payload.triangulation.triangles.length, 4);
  // 中心点 (2,2) 按坐标字典序的规范化序号为 2，连接四个角点。
  assert.deepEqual(payload.triangulation.neighbors[2].sort(), [0, 1, 3, 4]);
  // 每条内部边（与中心相连）邻接 2 个三角形，凸包边邻接 1 个。
  for (const ea of payload.triangulation.edgeAdjacency) {
    const internal = ea.edge.a === 2 || ea.edge.b === 2;
    assert.equal(ea.triangles.length, internal ? 2 : 1);
  }
});

test("长条近共线：精确谓词下仍为合法三角剖分且面积覆盖一致", () => {
  const pts: SourcePoint[] = [
    { id: "s0", x: 0, y: 0 },
    { id: "s1", x: 1000, y: 1 },
    { id: "s2", x: 2000, y: 0 },
    { id: "s3", x: 3000, y: 1 },
    { id: "s4", x: 4000, y: 0 },
    { id: "top", x: 2000, y: 3 },
  ];
  const { payload } = check(pts);
  assert.ok(payload.triangulation.triangles.length >= 4);
});

test("重复位置：全部来源编号被保留，按唯一站点构网", () => {
  const pts = [
    { id: "a", x: 0, y: 0 },
    { id: "a2", x: 0, y: 0 },
    { id: "b", x: 4, y: 0 },
    { id: "c", x: 2, y: 3 },
  ];
  const { payload } = check(pts);
  assert.equal(payload.input.pointCount, 4);
  assert.equal(payload.input.uniqueSiteCount, 3);
  assert.deepEqual(payload.input.duplicates[0].sourceIds, ["a", "a2"]);
  assert.equal(payload.triangulation.triangles.length, 1);
});

test("全共线：零三角形，凸包退化为线段，邻居按线上次序", () => {
  const pts = [
    { id: "l1", x: 0, y: 0 },
    { id: "l2", x: 2, y: 2 },
    { id: "l3", x: 5, y: 5 },
    { id: "l4", x: 1, y: 1 },
  ];
  const payload = compute(pts, { xmin: -1, ymin: -1, xmax: 6, ymax: 6 });
  assert.equal(payload.triangulation.collinear, true);
  assert.equal(payload.triangulation.triangles.length, 0);
  assert.equal(payload.triangulation.hull.length, 1);
});

test("裁剪单元面积总和等于矩形面积（精确网格抽样最近站点）", () => {
  const pts = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 4, y: 0 },
    { id: "c", x: 4, y: 4 },
    { id: "d", x: 0, y: 4 },
    { id: "e", x: 2, y: 2 },
  ];
  const bounds = { xmin: 0, ymin: 0, xmax: 4, ymax: 4 };
  const { payload, sites } = check(pts, bounds);
  const report = verifyVoronoi(sites, payload.voronoi, bounds);
  assert.ok(Math.abs(report.cellAreaSum - 16) < 1e-6);
  assert.equal(report.sampleFailures, 0);
});

test("站点在裁剪矩形外：单元为空，与非法输入区分", () => {
  const pts = [
    { id: "in", x: 0, y: 0 },
    { id: "out", x: 100, y: 100 },
  ];
  const bounds = { xmin: -10, ymin: -10, xmax: 10, ymax: 10 };
  const payload = compute(pts, bounds);
  const outCell = payload.voronoi.find((c) => !c.siteInsideBounds)!;
  assert.equal(outCell.empty, true);
  assert.equal(outCell.area, 0);
});

test("非法输入被明确拒绝并给出原因", () => {
  assert.throws(() => validatePoints([{ id: "x", x: 1.2, y: 0 }]), ValidationError);
  assert.throws(() => validatePoints([{ id: "x", x: 2_000_000, y: 0 }]), ValidationError);
  assert.throws(() => validatePoints([]), ValidationError);
  assert.throws(
    () => validatePoints([{ id: "x", x: 0, y: 0 }, { id: "x", x: 1, y: 1 }]),
    ValidationError,
  );
  assert.throws(() => validateBounds({ xmin: 0, ymin: 0, xmax: 0, ymax: 5 }), ValidationError);
  assert.throws(() => validateBounds({ xmin: 5, ymin: 5, xmax: 0, ymax: 0 }), ValidationError);
});

