/**
 * 端到端演示（直接使用已编译的 dist/ 模块与 SQLite）：
 * 导入 -> 构网 + 裁剪 Voronoi -> 插入新点 -> 比较受影响邻域 -> 导出；
 * 另含共线输入的实际输出，以及非法数据被拒绝的原因。
 * 运行：npm run build 后 node demo/run-demo.mjs
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from '../dist/src/store.js';
import { buildFromPoints, compareNeighborSets, exportCsv, exportJson } from '../dist/src/service.js';
import { verifyTriangulation, verifyVoronoi } from '../dist/src/verify.js';
import { writeFileSync, readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = join(root, 'data', 'demo.db');
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

const store = new Store(dbPath);
const load = (f) => JSON.parse(readFileSync(join(root, 'demo', f), 'utf-8'));
const rect = { minX: -2, minY: -2, maxX: 12, maxY: 12 };
const config = { tolerance: 1e-9, tieRule: 'source-id-lex-min' };

console.log('========== 1. 导入点集（含重复坐标 S005 / S005-DUP） ==========');
const points = load('points.json');
const v1 = store.upsertPointSet('demo-v1', points);
console.log('点集版本 id =', v1.row.id, '新建 =', v1.created, '输入点数 =', points.length);

console.log('\n========== 2. Delaunay 剖分 + 矩形裁剪 Voronoi ==========');
const out1 = buildFromPoints(points, rect);
console.log(`唯一站点 ${out1.sites.length}，三角形 ${out1.triangles.length}，凸包 ${out1.hull.length} 边`);
for (const s of out1.sites) console.log(`  站点#${s.index} 主编号=${s.id} 位置=(${s.x},${s.y}) 来源编号=${s.sourceIds.join(',')}`);
const save1 = store.saveResult(v1.row.id, store.upsertBoundary(v1.row.id, rect).row.id, config, out1);
console.log('结果版本 id =', save1.row.id, '新建 =', save1.created);

// 独立校验
const chk1 = verifyTriangulation(points.map((p) => ({ id: p.id, x: BigInt(p.x), y: BigInt(p.y) })));
console.log('剖分校验：', {
  全部逆时针: chk1.allCCW,
  空外接圆: chk1.emptyCircleHolds,
  无重复面: chk1.noDuplicateFaces,
  面积覆盖: chk1.areaCovered,
  凸包边一致: chk1.hullEdgesMatched,
});
const vchk1 = verifyVoronoi(out1, 10);
console.log('Voronoi 校验：', {
  单元面积和: Number(vchk1.cellAreaSum.toFixed(6)),
  矩形面积: vchk1.rectArea,
  面积误差: Number(vchk1.absError.toExponential(2)),
  采样点数: vchk1.samplesChecked,
  最近站点成立: vchk1.nearestHolds,
});

console.log('\n========== 3. 幂等：重复请求不产生重复结果 ==========');
const again = store.saveResult(v1.row.id, store.upsertBoundary(v1.row.id, rect).row.id, config, out1);
console.log('重复保存：结果 id =', again.row.id, '新建 =', again.created);

console.log('\n========== 4. 插入新点 S006（冻结旧版本，生成新版本） ==========');
const extra = load('new-point.json');
const v2Row = store.appendPoints(v1.row.id, extra, 'demo-v2');
const points2 = JSON.parse(v2Row.points_json);
const out2 = buildFromPoints(points2, rect);
const save2 = store.saveResult(v2Row.id, store.upsertBoundary(v2Row.id, rect).row.id, config, out2);
console.log('新点集版本 id =', v2Row.id, '新结果 id =', save2.row.id, '三角形 =', out2.triangles.length);
console.log('旧版本结果仍为 id =', save1.row.id, '，三角形数仍为 =', JSON.parse(save1.row.result_json).triangles.length);

console.log('\n========== 5. 比较受影响邻域（按来源编号对齐） ==========');
const diff = compareNeighborSets(out1, out2);
console.log(JSON.stringify(diff, null, 2));

console.log('\n========== 6. 导出 JSON / CSV ==========');
writeFileSync(join(root, 'demo', 'export-result.json'), exportJson(out2));
writeFileSync(join(root, 'demo', 'export-triangles.csv'), exportCsv(out2, 'triangles'));
writeFileSync(join(root, 'demo', 'export-cells.csv'), exportCsv(out2, 'cells'));
console.log('已写出 demo/export-result.json、export-triangles.csv、export-cells.csv');
console.log('三角形 CSV 预览：');
console.log(exportCsv(out2, 'triangles'));

console.log('\n========== 7. 共线输入的实际输出 ==========');
const col = buildFromPoints(load('collinear.json'));
console.log(JSON.stringify({
  degenerate: col.degenerate,
  reason: col.degenerateReason,
  triangles: col.triangles.length,
  hullOrder: col.hull.map((i) => col.sites[i].id),
  adjacency: col.adjacency.map((a) => ({
    id: col.sites[a.siteIndex].id,
    neighbors: a.neighbors.map((j) => col.sites[j].id),
  })),
}, null, 2));

console.log('\n========== 8. 非法数据被拒绝（原因必须明确） ==========');
const badCases = [
  ['非整数坐标', [{ id: 'a', x: 1.5, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 0, y: 1 }]],
  ['坐标越界', [{ id: 'a', x: 9_999_999, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 0, y: 1 }]],
  ['编号重复', [{ id: 'a', x: 0, y: 0 }, { id: 'a', x: 1, y: 0 }, { id: 'c', x: 0, y: 1 }]],
];
for (const [name, pts] of badCases) {
  try {
    buildFromPoints(pts);
    console.log(`  ${name}: 未拒绝（异常！）`);
  } catch (e) {
    console.log(`  ${name}: 已拒绝 -> ${e.message}`);
  }
}
try {
  buildFromPoints(points, { minX: 0, minY: 0, maxX: 0, maxY: 10 });
} catch (e) {
  console.log(`  零面积裁剪矩形: 已拒绝 -> ${e.message}`);
}

console.log('\n演示完成。数据库：data/demo.db');
