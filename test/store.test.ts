import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { buildFromPoints, compareNeighborSets } from '../src/service.js';

const points = [
  { id: 'S1', x: 0, y: 0 }, { id: 'S2', x: 10, y: 0 },
  { id: 'S3', x: 10, y: 10 }, { id: 'S4', x: 0, y: 10 },
];

function tmpDb() {
  return join(tmpdir(), `tri-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(handles: Store[], db: string) {
  for (const h of handles) {
    try { h.close(); } catch { /* 已关闭 */ }
  }
  rmSync(db, { force: true });
  rmSync(db + '-wal', { force: true });
  rmSync(db + '-shm', { force: true });
}

test('点集冻结：追加点产生新版本，旧版本结果不变；请求幂等', () => {
  const db = tmpDb();
  const handles: Store[] = [];
  try {
    const store = new Store(db);
    handles.push(store);
    const v1 = store.upsertPointSet('set', points);
    const rect = { minX: -1, minY: -1, maxX: 11, maxY: 11 };
    const cfg = { tolerance: 1e-9, tieRule: 'source-id-lex-min' };

    const out1 = buildFromPoints(points, rect);
    const bid1 = store.upsertBoundary(v1.row.id, rect).row.id;
    const r1a = store.saveResult(v1.row.id, bid1, cfg, out1);
    const r1b = store.saveResult(v1.row.id, bid1, cfg, out1);
    assert.equal(r1a.row.id, r1b.row.id);
    assert.equal(r1a.created, true);
    assert.equal(r1b.created, false);

    const v2Row = store.appendPoints(v1.row.id, [{ id: 'S5', x: 5, y: 5 }], 'set2');
    const out2 = buildFromPoints(JSON.parse(v2Row.points_json), rect);
    const bid2 = store.upsertBoundary(v2Row.id, rect).row.id;
    const r2 = store.saveResult(v2Row.id, bid2, cfg, out2);
    assert.notEqual(r1a.row.id, r2.row.id);

    const frozen = JSON.parse(store.getResult(r1a.row.id)!.result_json);
    assert.equal(frozen.triangles.length, 2);
    assert.equal(JSON.parse(store.getResult(r2.row.id)!.result_json).triangles.length, 4);

    store.close();
    const reopen = new Store(db);
    handles.push(reopen);
    assert.equal(reopen.listPointSets().length, 2);
    assert.equal(reopen.listResults().length, 2);

    const diff = compareNeighborSets(out1, out2);
    assert.ok(diff.added.S1?.includes('S5'));
  } finally {
    cleanup(handles, db);
  }
});

test('重复坐标 + 重复导入均幂等', () => {
  const db = tmpDb();
  const handles: Store[] = [];
  try {
    const store = new Store(db);
    handles.push(store);
    const pts = [...points, { id: 'DUP', x: 0, y: 0 }];
    const a = store.upsertPointSet('x', pts);
    const b = store.upsertPointSet('x', pts);
    assert.equal(a.row.id, b.row.id);
    const out = buildFromPoints(pts);
    assert.equal(out.sites.length, 4);
    assert.deepEqual(out.sites.find((s) => s.sourceIds.length > 1)!.sourceIds.sort(), ['DUP', 'S1']);
  } finally {
    cleanup(handles, db);
  }
});
