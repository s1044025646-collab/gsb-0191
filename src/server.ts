import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { exportCsv, exportJson } from "./exporters.js";
import { openDatabase } from "./db.js";
import {
  addPoints,
  compareNeighborhoods,
  compute,
  createPointSet,
  getPointSet,
  getResult,
  listPointSets,
  triangulate,
} from "./service.js";
import { ValidationError } from "./validate.js";
import { verifyTriangulation, verifyVoronoi } from "./geometry/verify.js";
import { deduplicate } from "./validate.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const DB_FILE = join(DATA_DIR, "app.db");

openDatabase(DB_FILE);

interface JsonReq {
  status: number;
  body: unknown;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function handle(method: string, pathname: string, url: URL, req: IncomingMessage): Promise<JsonReq> {
  const seg = decodeURIComponent(pathname).split("/").filter(Boolean);

  if (method === "GET" && seg.length === 1 && seg[0] === "health") {
    return { status: 200, body: { ok: true, port: PORT, dataDir: DATA_DIR } };
  }

  if (seg[0] === "point-sets") {
    if (method === "GET" && seg.length === 1) {
      return { status: 200, body: listPointSets() };
    }
    if (method === "POST" && seg.length === 1) {
      const body = (await readJson(req)) as { name?: unknown; points?: unknown };
      const ps = createPointSet(body.name, body.points);
      return { status: 201, body: ps };
    }
    const id = Number(seg[1]);
    if (Number.isFinite(id)) {
      if (method === "GET" && seg.length === 2) {
        return { status: 200, body: getPointSet(id) };
      }
      if (method === "POST" && seg.length === 3 && seg[2] === "points") {
        const body = (await readJson(req)) as { points?: unknown };
        return { status: 200, body: addPoints(id, body.points) };
      }
      if (method === "POST" && seg.length === 3 && seg[2] === "triangulate") {
        const body = (await readJson(req)) as { bounds?: unknown; config?: unknown };
        const r = triangulate(id, body.bounds, body.config);
        return { status: r.created ? 201 : 200, body: { resultId: r.resultId, created: r.created, result: r.payload } };
      }
    }
  }

  if (seg[0] === "results") {
    const id = Number(seg[1]);
    if (Number.isFinite(id)) {
      if (method === "GET" && seg.length === 2) {
        return { status: 200, body: getResult(id) };
      }
      if (method === "GET" && seg.length === 3 && seg[2] === "cell") {
        const { payload } = getResult(id);
        const siteParam = url.searchParams.get("siteIndex");
        const sourceId = url.searchParams.get("sourceId");
        let siteIndex: number | undefined;
        if (siteParam !== null) siteIndex = Number(siteParam);
        else if (sourceId !== null) {
          siteIndex = payload.sites.find((s) => s.sourceIds.includes(sourceId))?.siteIndex;
          if (siteIndex === undefined) throw new ValidationError(`来源编号未找到：${sourceId}`);
        }
        if (siteIndex === undefined || !Number.isInteger(siteIndex)) {
          throw new ValidationError("需要查询参数 siteIndex 或 sourceId");
        }
        const cell = payload.voronoi.find((c) => c.siteIndex === siteIndex);
        if (!cell) throw new ValidationError(`站点序号不存在：${siteIndex}`);
        return { status: 200, body: { tolerance: payload.tolerance, cell, site: payload.sites[siteIndex] } };
      }
      if (method === "GET" && seg.length === 3 && seg[2] === "export") {
        const { payload } = getResult(id);
        const format = url.searchParams.get("format") ?? "json";
        if (format === "json") {
          return { status: 200, body: { format: "json", content: JSON.parse(exportJson(payload)) } };
        }
        if (format === "csv") {
          return { status: 200, body: { format: "csv", tables: exportCsv(payload) } };
        }
        throw new ValidationError("format 仅支持 json 或 csv");
      }
      if (method === "GET" && seg.length === 3 && seg[2] === "verify") {
        const { payload } = getResult(id);
        const sites = deduplicate(
          payload.sites.flatMap((s) => s.sourceIds.map((sid) => ({ id: sid, x: s.x, y: s.y }))),
        );
        const triReport = verifyTriangulation(sites, payload.triangulation);
        const vorReport = verifyVoronoi(sites, payload.voronoi, payload.bounds, payload.tolerance);
        return {
          status: 200,
          body: {
            triangulation: triReport,
            voronoi: { ...vorReport, ok: vorReport.errors.length === 0 },
          },
        };
      }
    }
  }

  if (method === "POST" && seg.length === 2 && seg[0] === "results" && seg[1] === "compare") {
    const body = (await readJson(req)) as { beforeResultId?: unknown; afterResultId?: unknown };
    const before = getResult(Number(body.beforeResultId)).payload;
    const after = getResult(Number(body.afterResultId)).payload;
    return { status: 200, body: compareNeighborhoods(before, after) };
  }

  if (method === "POST" && seg.length === 1 && seg[0] === "compute") {
    const body = (await readJson(req)) as { points?: unknown; bounds?: unknown; config?: unknown };
    return { status: 200, body: compute(body.points, body.bounds, body.config) };
  }

  return { status: 404, body: { error: "未找到对应路由", method, path: pathname } };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  handle(req.method ?? "GET", url.pathname, url, req)
    .then((r) => send(res, r.status, r.body))
    .catch((err: unknown) => {
      if (err instanceof SyntaxError) {
        return send(res, 400, { error: "请求体不是合法 JSON", detail: err.message });
      }
      if (err instanceof ValidationError) {
        return send(res, 422, { error: err.message });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return send(res, 500, { error: "服务器内部错误", detail: msg });
    });
});

server.listen(PORT, () => {
  console.log(`[delaunay-voronoi] HTTP API 已启动: http://localhost:${PORT}`);
  console.log(`[delaunay-voronoi] 数据目录: ${DATA_DIR}`);
});

export { server };
