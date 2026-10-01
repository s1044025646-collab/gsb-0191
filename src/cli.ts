#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, type InPoint } from './store.js';
import {
  buildFromPoints,
  compareNeighborSets,
  exportCsv,
  exportJson,
  parsePointsCsv,
} from './service.js';
import type { ClipRect } from './voronoi.js';

function usage() {
  console.log(`用法:
  triang import --name 名称 --file points.json|csv [--db data/app.db]
  triang list
  triang build --pointset ID [--rect minX,minY,maxX,maxY] [--out result.json]
  triang append --pointset ID --file extra.json [--name 新名称]
  triang compare --result A --result B
  triang export --result ID --format json|csv [--kind points|triangles|cells] [--out file]
  triang query-cell --result ID --source-id S001

点文件 JSON 格式: [{"id":"S001","x":0,"y":0}, ...]
CSV 格式: id,x,y  (允许重复坐标，编号必须唯一)`);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadPoints(file: string): InPoint[] {
  const text = readFileSync(file, 'utf-8');
  if (file.toLowerCase().endsWith('.csv')) return parsePointsCsv(text);
  return JSON.parse(text) as InPoint[];
}

function parseRect(s: string): ClipRect {
  const [minX, minY, maxX, maxY] = s.split(',').map(Number);
  return { minX, minY, maxX, maxY };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dbPath = arg(rest, 'db') ?? join(process.cwd(), 'data', 'app.db');
  const store = new Store(dbPath);

  switch (cmd) {
    case 'import': {
      const file = arg(rest, 'file');
      const name = arg(rest, 'name') ?? 'default';
      if (!file) throw new Error('需要 --file');
      const points = loadPoints(file);
      const { row, created } = store.upsertPointSet(name, points);
      console.log(JSON.stringify({ action: 'import', id: row.id, created, count: points.length }, null, 2));
      break;
    }
    case 'list': {
      for (const r of store.listPointSets()) {
        console.log(`${r.id}\t${r.name}\t${JSON.parse(r.points_json).length} 点\t${r.created_at}`);
      }
      break;
    }
    case 'build': {
      const id = Number(arg(rest, 'pointset'));
      const ps = store.getPointSet(id);
      if (!ps) throw new Error(`点集不存在：${id}`);
      const rectStr = arg(rest, 'rect');
      const rect = rectStr ? parseRect(rectStr) : undefined;
      const output = buildFromPoints(JSON.parse(ps.points_json), rect);
      let boundaryId: number | null = null;
      if (rect) boundaryId = store.upsertBoundary(id, rect).row.id;
      const saved = store.saveResult(id, boundaryId, { tolerance: 1e-9, tieRule: 'source-id-lex-min' }, output);
      console.log(JSON.stringify({ resultId: saved.row.id, created: saved.created }, null, 2));
      const out = arg(rest, 'out');
      if (out) writeFileSync(out, exportJson(output));
      console.log(`三角形 ${output.triangles.length} 个，凸包点 ${output.hull.length} 个，退化=${output.degenerate}`);
      if (output.voronoi) {
        console.log(`Voronoi 单元面积和=${output.voronoi.areaCheck!.cellAreaSum.toFixed(6)}，矩形面积=${output.voronoi.areaCheck!.rectArea.toFixed(6)}`);
      }
      break;
    }
    case 'append': {
      const id = Number(arg(rest, 'pointset'));
      const file = arg(rest, 'file');
      if (!file) throw new Error('需要 --file');
      const row = store.appendPoints(id, loadPoints(file), arg(rest, 'name'));
      console.log(JSON.stringify({ newPointSetId: row.id, count: JSON.parse(row.points_json).length }, null, 2));
      break;
    }
    case 'compare': {
      const ids = rest.filter((_, i) => rest[i - 1] === '--result').map(Number);
      const r1 = store.getResult(ids[0]);
      const r2 = store.getResult(ids[1]);
      if (!r1 || !r2) throw new Error('结果不存在');
      console.log(JSON.stringify(compareNeighborSets(JSON.parse(r1.result_json), JSON.parse(r2.result_json)), null, 2));
      break;
    }
    case 'export': {
      const id = Number(arg(rest, 'result'));
      const row = store.getResult(id);
      if (!row) throw new Error(`结果不存在：${id}`);
      const output = JSON.parse(row.result_json);
      const format = arg(rest, 'format') ?? 'json';
      const content = format === 'csv'
        ? exportCsv(output, (arg(rest, 'kind') as any) ?? 'triangles')
        : exportJson(output);
      const out = arg(rest, 'out');
      if (out) writeFileSync(out, content);
      else console.log(content);
      break;
    }
    case 'query-cell': {
      const id = Number(arg(rest, 'result'));
      const sourceId = arg(rest, 'source-id');
      const row = store.getResult(id);
      if (!row) throw new Error(`结果不存在：${id}`);
      const out = JSON.parse(row.result_json);
      const cell = out.voronoi?.cells.find((c: any) => c.sourceIds.includes(sourceId));
      if (!cell) throw new Error(`单元不存在或无 Voronoi 数据：${sourceId}`);
      console.log(JSON.stringify(cell, null, 2));
      break;
    }
    default:
      usage();
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});
