import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, type InPoint, type RectSpec, type AlgoConfig } from './store.js';
import {
  buildFromPoints,
  compareNeighborSets,
  exportCsv,
  exportJson,
  validatePoints,
  type BuildOutput,
} from './service.js';
import { validateRect } from './voronoi.js';
import { MAX_COORD, MAX_POINTS } from './geometry.js';

export interface ServerOptions {
  port: number;
  dataDir: string;
}

interface Ctx {
  store: Store;
}

function send(res: any, status: number, body: unknown, contentType = 'application/json; charset=utf-8') {
  const payload = contentType.includes('json') ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function buildCached(ctx: Ctx, pointsetId: number, rect?: RectSpec, config?: AlgoConfig): { output: BuildOutput; resultId: number; created: boolean } {
  const ps = ctx.store.getPointSet(pointsetId);
  if (!ps) throw new Error(`点集不存在：${pointsetId}`);
  const pts = JSON.parse(ps.points_json) as InPoint[];
  const output = buildFromPoints(pts, rect, config);
  let boundaryId: number | null = null;
  if (rect) {
    boundaryId = ctx.store.upsertBoundary(pointsetId, rect).row.id;
  }
  const saved = ctx.store.saveResult(pointsetId, boundaryId, config ?? { tolerance: 1e-9, tieRule: 'source-id-lex-min' }, output);
  return { output, resultId: saved.row.id, created: saved.created };
}

export function createApp(store: Store): Server {
  const ctx: Ctx = { store };

  return createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname;
    const method = req.method!;
    try {
      if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, maxCoord: Number(MAX_COORD), maxPoints: MAX_POINTS });
      }
      if (method === 'GET' && path === '/api/pointsets') {
        return send(res, 200, ctx.store.listPointSets().map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, count: JSON.parse(r.points_json).length })));
      }
      if (method === 'POST' && path === '/api/pointsets') {
        const body = await readJson(req);
        const points: InPoint[] = body.points;
        const err = validatePoints(points);
        if (err) return send(res, 400, { error: err });
        const { row, created } = ctx.store.upsertPointSet(String(body.name ?? 'default'), points);
        return send(res, created ? 201 : 200, { id: row.id, name: row.name, created, count: points.length });
      }
      if (method === 'POST' && /^\/api\/pointsets\/\d+\/append$/.test(path)) {
        const id = Number(path.split('/')[3]);
        const body = await readJson(req);
        const err = validatePoints(body.points);
        if (err) return send(res, 400, { error: err });
        const row = ctx.store.appendPoints(id, body.points, body.name);
        return send(res, 201, { id: row.id, name: row.name, count: JSON.parse(row.points_json).length, note: '旧点集及其结果已冻结' });
      }
      if (method === 'POST' && /^\/api\/pointsets\/\d+\/triangulate$/.test(path)) {
        const id = Number(path.split('/')[3]);
        const built = buildCached(ctx, id);
        return send(res, 200, { resultId: built.resultId, created: built.created, ...built.output });
      }
      if (method === 'POST' && /^\/api\/pointsets\/\d+\/voronoi$/.test(path)) {
        const id = Number(path.split('/')[3]);
        const body = await readJson(req);
        const rect: RectSpec = { minX: +body.minX, minY: +body.minY, maxX: +body.maxX, maxY: +body.maxY };
        const rerr = validateRect(rect);
        if (rerr) return send(res, 400, { error: rerr });
        const config: AlgoConfig = { tolerance: 1e-9, tieRule: 'source-id-lex-min' };
        const built = buildCached(ctx, id, rect, config);
        return send(res, 200, { resultId: built.resultId, created: built.created, ...built.output });
      }
      if (method === 'GET' && /^\/api\/results\/\d+$/.test(path)) {
        const id = Number(path.split('/')[3]);
        const row = ctx.store.getResult(id);
        if (!row) return send(res, 404, { error: `结果不存在：${id}` });
        res.setHeader('Content-Disposition', `inline; filename="result-${id}.json"`);
        if (url.searchParams.get('format') === 'csv') {
          const kind = (url.searchParams.get('kind') as any) ?? 'triangles';
          return send(res, 200, exportCsv(JSON.parse(row.result_json), kind), 'text/csv; charset=utf-8');
        }
        return send(res, 200, JSON.parse(row.result_json), 'application/json; charset=utf-8');
      }
      if (method === 'GET' && /^\/api\/results\/\d+\/export$/.test(path)) {
        const id = Number(path.split('/')[3]);
        const row = ctx.store.getResult(id);
        if (!row) return send(res, 404, { error: `结果不存在：${id}` });
        const output = JSON.parse(row.result_json) as BuildOutput;
        const fmt = url.searchParams.get('format') ?? 'json';
        if (fmt === 'csv') {
          const kind = (url.searchParams.get('kind') as any) ?? 'triangles';
          return send(res, 200, exportCsv(output, kind), 'text/csv; charset=utf-8');
        }
        return send(res, 200, output);
      }
      if (method === 'GET' && path === '/api/results') {
        const ps = url.searchParams.get('pointsetId');
        return send(res, 200, ctx.store.listResults(ps ? Number(ps) : undefined).map((r) => ({
          id: r.id, pointsetId: r.pointset_id, boundaryId: r.boundary_id, createdAt: r.created_at,
        })));
      }
      if (method === 'POST' && path === '/api/neighborhoods/compare') {
        const body = await readJson(req);
        const r1 = ctx.store.getResult(Number(body.resultIdA));
        const r2 = ctx.store.getResult(Number(body.resultIdB));
        if (!r1 || !r2) return send(res, 404, { error: '结果不存在' });
        return send(res, 200, compareNeighborSets(JSON.parse(r1.result_json), JSON.parse(r2.result_json)));
      }
      if (method === 'POST' && path === '/api/cells/query') {
        const body = await readJson(req);
        const row = ctx.store.getResult(Number(body.resultId));
        if (!row) return send(res, 404, { error: '结果不存在' });
        const out = JSON.parse(row.result_json) as BuildOutput;
        if (!out.voronoi) return send(res, 400, { error: '该结果不含 Voronoi 单元' });
        if (body.sourceId) {
          const cell = out.voronoi.cells.find((c) => c.sourceIds.includes(String(body.sourceId)));
          if (!cell) return send(res, 404, { error: `来源编号不存在：${body.sourceId}` });
          return send(res, 200, cell);
        }
        return send(res, 200, out.voronoi.cells[Number(body.siteIndex ?? 0)]);
      }
      return send(res, 404, { error: `未找到路由：${method} ${path}` });
    } catch (e: any) {
      return send(res, 400, { error: e?.message ?? String(e) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3000);
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
  const store = new Store(join(dataDir, 'app.db'));
  createApp(store).listen(port, () => {
    console.log(`三角剖分服务已启动: http://localhost:${port}  数据目录: ${dataDir}`);
  });
}
