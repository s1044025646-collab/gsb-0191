import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulate, orient, inCircle, type SourcePoint } from '../src/geometry.js';
import { verifyTriangulation } from '../src/verify.js';
import { buildFromPoints } from '../src/service.js';
import { verifyVoronoi } from '../src/verify.js';

const P = (rows: Array<[string, number, number]>): SourcePoint[] =>
  rows.map(([id, x, y]) => ({ id, x: BigInt(x), y: BigInt(y) }));

test('单个三角形：1 个 CCW 三角形，空圆成立', () => {
  const pts = P([['a', 0, 0], ['b', 4, 0], ['c', 0, 3]]);
  const tr = triangulate(pts);
  assert.equal(tr.triangles.length, 1);
  assert.equal(tr.hull.length, 3);
  const [i, j, k] = tr.triangles[0].v;
  assert.ok(orient(tr.sites[i], tr.sites[j], tr.sites[k]) > 0n);
  const rep = verifyTriangulation(pts);
  assert.deepEqual(
    { ...rep, doubledAreaSum: rep.doubledAreaSum.toString(), hullDoubledArea: rep.hullDoubledArea.toString() },
    {
      triangles: 1, uniqueSites: 3, doubledAreaSum: '12', hullDoubledArea: '12',
      allCCW: true, emptyCircleHolds: true, noDuplicateFaces: true,
      areaCovered: true, hullEdgesMatched: true,
    },
  );
});

test('正方形四点共圆：确定地得到 2 个三角形，且不随编号改名变化', () => {
  const mk = (names: [string, string, string, string]) =>
    triangulate(P([
      [names[0], 0, 0], [names[1], 10, 0], [names[2], 10, 10], [names[3], 0, 10],
    ]));
  const t1 = mk(['a', 'b', 'c', 'd']);
  const t2 = mk(['zz', 'yy', 'xx', 'ww']);
  assert.equal(t1.triangles.length, 2);
  // 几何顶点索引（按坐标字典序）应完全相同
  assert.deepEqual(t1.triangles.map((t) => t.v), t2.triangles.map((t) => t.v));
  // 四个点两两在对方外接圆上（共圆 => incircle == 0）
  const s = t1.sites;
  const tri0 = t1.triangles[0].v.map((i) => s[i]);
  const fourth = s[t1.triangles[1].v.find((v) => !t1.triangles[0].v.includes(v))!];
  assert.equal(inCircle(tri0[0], tri0[1], tri0[2], fourth), 0n);
  const rep = verifyTriangulation(P([['a', 0, 0], ['b', 10, 0], ['c', 10, 10], ['d', 0, 10]]));
  for (const key of ['allCCW', 'emptyCircleHolds', 'noDuplicateFaces', 'areaCovered', 'hullEdgesMatched'] as const) {
    assert.equal((rep as any)[key], true, key);
  }
});

test('正方形含中心点：4 个三角形，内部点不被遗漏，边邻接正确', () => {
  const pts = P([['a', 0, 0], ['b', 10, 0], ['c', 10, 10], ['d', 0, 10], ['e', 5, 5]]);
  const tr = triangulate(pts);
  assert.equal(tr.triangles.length, 4);
  const center = tr.indexBySource.get('e')!;
  assert.deepEqual(tr.adjacency[center].neighbors, [0, 1, 3, 4]);
  // 内部边（中心-角点）两侧都有三角形
  for (const corner of [0, 1, 3, 4]) {
    const key = center < corner ? `${center},${corner}` : `${corner},${center}`;
    assert.equal(tr.edgeTriangles.get(key)!.length, 2);
  }
  const rep = verifyTriangulation(pts);
  assert.ok(rep.emptyCircleHolds && rep.areaCovered && rep.hullEdgesMatched);
});

test('长条近共线点集：仍可合法剖分且空圆成立', () => {
  const rows: Array<[string, number, number]> = [];
  for (let i = 0; i <= 10; i++) rows.push([`p${i}`, i * 100, i === 5 ? 1 : 0]);
  const pts = P(rows);
  const rep = verifyTriangulation(pts);
  assert.ok(rep.allCCW);
  assert.ok(rep.emptyCircleHolds);
  assert.ok(rep.areaCovered);
  assert.ok(rep.hullEdgesMatched);
  assert.ok(rep.triangles >= 9);
});

test('严格共线：degenerate=true、无三角形、邻居为链', () => {
  const pts = P([['a', 0, 0], ['b', 3, 3], ['c', 7, 7], ['d', -2, -2]]);
  const tr = triangulate(pts);
  assert.equal(tr.degenerate, true);
  assert.equal(tr.triangles.length, 0);
  // 排序后端点邻居只有 1 个
  const endpoints = tr.adjacency.filter((a) => a.neighbors.length === 1);
  assert.equal(endpoints.length, 2);
  assert.match(tr.degenerateReason!, /共线/);
});

test('重复坐标：聚合为站点并保留全部来源编号', () => {
  const pts = P([['a', 1, 1], ['b', 5, 1], ['c', 1, 5], ['dup1', 1, 1], ['dup2', 1, 1]]);
  const tr = triangulate(pts);
  assert.equal(tr.sites.length, 3);
  const merged = tr.sites.find((s) => s.sourceIds.length === 3)!;
  assert.deepEqual(merged.sourceIds.sort(), ['a', 'dup1', 'dup2']);
  assert.equal(tr.triangles.length, 1);
  for (const id of ['a', 'dup1', 'dup2']) {
    assert.equal(tr.indexBySource.get(id), tr.indexBySource.get('a'));
  }
});

test('非法坐标被明确拒绝', () => {
  assert.throws(
    () => buildFromPoints([{ id: 'a', x: 1.5, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 0, y: 1 }]),
    /整数/,
  );
  assert.throws(
    () => buildFromPoints([{ id: 'a', x: 9_999_999, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 0, y: 1 }]),
    /范围/,
  );
  assert.throws(
    () => buildFromPoints([{ id: 'a', x: 0, y: 0 }, { id: 'a', x: 1, y: 0 }, { id: 'c', x: 0, y: 1 }]),
    /编号重复/,
  );
});

test('零面积裁剪矩形被拒绝', () => {
  assert.throws(
    () => buildFromPoints(
      [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 0 }, { id: 'c', x: 0, y: 3 }],
      { minX: 0, minY: 0, maxX: 0, maxY: 10 },
    ),
    /零面积/,
  );
});

test('Voronoi：单元面积之和等于矩形面积，内部样点属于最近站点', () => {
  const points = [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 },
    { id: 'c', x: 10, y: 10 }, { id: 'd', x: 0, y: 10 }, { id: 'e', x: 5, y: 5 },
  ];
  const out = buildFromPoints(points, { minX: -2, minY: -2, maxX: 12, maxY: 12 });
  const rep = verifyVoronoi(out, 10);
  assert.ok(rep.absError < 1e-6, `面积误差过大: ${rep.absError}`);
  assert.ok(rep.nearestHolds);
});

test('Voronoi 等距边界归属一致：相邻两站点编号顺序交换时单元仍铺满矩形', () => {
  const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const o1 = buildFromPoints([{ id: 'a', x: 2, y: 5 }, { id: 'b', x: 8, y: 5 }], rect);
  const o2 = buildFromPoints([{ id: 'b', x: 2, y: 5 }, { id: 'a', x: 8, y: 5 }], rect);
  for (const o of [o1, o2]) {
    const rep = verifyVoronoi(o, 8);
    assert.ok(rep.absError < 1e-6);
    assert.ok(rep.nearestHolds);
  }
});
