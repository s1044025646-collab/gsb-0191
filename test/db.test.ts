import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { closeDatabase, openDatabase } from "../src/db.js";
import {
  addPoints,
  compareNeighborhoods,
  createPointSet,
  getResult,
  triangulate,
} from "../src/service.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gsb-"));
  openDatabase(join(dir, "app.db"));
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const square = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 4, y: 0 },
  { id: "c", x: 4, y: 4 },
  { id: "d", x: 0, y: 4 },
];
const bounds = { xmin: -1, ymin: -1, xmax: 5, ymax: 5 };

test("重复请求不产生重复结果（幂等）", () => {
  const ps = createPointSet("t", square);
  const r1 = triangulate(ps.id, bounds);
  const r2 = triangulate(ps.id, bounds);
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.resultId, r2.resultId);
});

test("旧结果冻结：新增点后旧结果保持不变，产生新版本结果", () => {
  const ps = createPointSet("t", square);
  const before = triangulate(ps.id, bounds);
  const beforeSnapshot = JSON.stringify(getResult(before.resultId).payload.triangulation);

  addPoints(ps.id, [{ id: "e", x: 2, y: 2 }]);
  const after = triangulate(ps.id, bounds);
  assert.notEqual(after.resultId, before.resultId);

  const oldNow = JSON.stringify(getResult(before.resultId).payload.triangulation);
  assert.equal(oldNow, beforeSnapshot);
  assert.equal(getResult(after.resultId).payload.triangulation.triangles.length, 4);

  const diff = compareNeighborhoods(getResult(before.resultId).payload, getResult(after.resultId).payload);
  assert.deepEqual(diff.addedPoints, [{ id: "e", x: 2, y: 2 }]);
  assert.ok(diff.changedSites.length > 0);
});

