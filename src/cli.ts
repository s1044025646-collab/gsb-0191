import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./db.js";
import { exportCsv, exportJson } from "./exporters.js";
import {
  addPoints,
  compareNeighborhoods,
  createPointSet,
  getPointSet,
  getResult,
  listPointSets,
  triangulate,
} from "./service.js";
import { ValidationError } from "./validate.js";

function readJsonArg(value: string): unknown {
  const text = readFileSync(value, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function parseBounds(value: string): unknown {
  if (value.startsWith("@")) return readJsonArg(value.slice(1));
  return JSON.parse(value);
}

function print(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

function usage(): void {
  process.stdout.write(
    [
      "用法: node --experimental-strip-types src/cli.ts <命令> [参数]",
      "",
      "数据集管理:",
      "  init-db [--db data/app.db]",
      "  point-set create --name <名称> --points @points.json",
      "  point-set list",
      "  point-set get --id <点集ID>",
      "  point-set add-points --id <点集ID> --points @more.json",
      "",
      "构网与查询:",
      "  triangulate --id <点集ID> --bounds <{...}|@bounds.json> [--config <{...}>]",
      "  result get --result <结果ID>",
      "  result cell --result <结果ID> (--site-index <n> | --source-id <ID>)",
      "  result compare --before <结果ID> --after <结果ID>",
      "",
      "导出:",
      "  result export --result <结果ID> --format json|csv [--out <前缀或文件>]",
      "",
      "环境变量: PORT, DATA_DIR, GSB_DB",
      "",
    ].join("\n"),
  );
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireArg(args: string[], name: string): string {
  const v = arg(args, name);
  if (v === undefined) throw new ValidationError(`缺少参数 ${name}`);
  return v;
}

export function runCli(argv: string[]): void {
  const dbPath = process.env.GSB_DB ?? join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "app.db");
  openDatabase(dbPath);

  // 一级命令（triangulate / init-db）无子命令；point-set / result 有二级子命令。
  const cmd = argv[0];
  const twoLevel = cmd === "point-set" || cmd === "result";
  const sub = twoLevel ? argv[1] : undefined;
  const rest = twoLevel ? argv.slice(2) : argv.slice(1);
  try {
    if (cmd === "init-db") {
      print({ ok: true, db: dbPath });
    } else if (cmd === "point-set" && sub === "create") {
      const name = requireArg(rest, "--name");
      const pointsFile = requireArg(rest, "--points");
      print(createPointSet(name, readJsonArg(pointsFile.startsWith("@") ? pointsFile.slice(1) : pointsFile)));
    } else if (cmd === "point-set" && sub === "list") {
      print(listPointSets());
    } else if (cmd === "point-set" && sub === "get") {
      print(getPointSet(Number(requireArg(rest, "--id"))));
    } else if (cmd === "point-set" && sub === "add-points") {
      const id = Number(requireArg(rest, "--id"));
      const pointsFile = requireArg(rest, "--points");
      print(addPoints(id, readJsonArg(pointsFile.startsWith("@") ? pointsFile.slice(1) : pointsFile)));
    } else if (cmd === "triangulate") {
      const id = Number(requireArg(rest, "--id"));
      const bounds = parseBounds(requireArg(rest, "--bounds"));
      const configRaw = arg(rest, "--config");
      const config = configRaw ? parseBounds(configRaw) : undefined;
      const r = triangulate(id, bounds, config);
      print({ resultId: r.resultId, created: r.created, result: r.payload });
    } else if (cmd === "result" && sub === "get") {
      print(getResult(Number(requireArg(rest, "--result"))));
    } else if (cmd === "result" && sub === "cell") {
      const resultId = Number(requireArg(rest, "--result"));
      const { payload } = getResult(resultId);
      const siteArg = arg(rest, "--site-index");
      const sourceArg = arg(rest, "--source-id");
      let siteIndex: number | undefined;
      if (siteArg !== undefined) siteIndex = Number(siteArg);
      else if (sourceArg !== undefined) {
        const s = payload.sites.find((x) => x.sourceIds.includes(sourceArg));
        if (!s) throw new ValidationError(`来源编号未找到：${sourceArg}`);
        siteIndex = s.siteIndex;
      } else {
        throw new ValidationError("需要 --site-index 或 --source-id");
      }
      print({ tolerance: payload.tolerance, site: payload.sites[siteIndex!], cell: payload.voronoi[siteIndex!] });
    } else if (cmd === "result" && sub === "compare") {
      const before = getResult(Number(requireArg(rest, "--before"))).payload;
      const after = getResult(Number(requireArg(rest, "--after"))).payload;
      print(compareNeighborhoods(before, after));
    } else if (cmd === "result" && sub === "export") {
      const resultId = Number(requireArg(rest, "--result"));
      const format = arg(rest, "--format") ?? "json";
      const out = arg(rest, "--out");
      const { payload } = getResult(resultId);
      if (format === "json") {
        const content = exportJson(payload);
        if (out) writeFileSync(out, content, "utf8");
        else process.stdout.write(content + "\n");
      } else if (format === "csv") {
        const bundle = exportCsv(payload);
        if (out) {
          for (const [table, content] of Object.entries(bundle)) {
            writeFileSync(`${out}.${table}.csv`, content + "\r\n", "utf8");
          }
        } else {
          for (const [table, content] of Object.entries(bundle)) {
            process.stdout.write(`# ${table}\r\n${content}\r\n`);
          }
        }
      } else {
        throw new ValidationError("format 仅支持 json 或 csv");
      }
      print({ ok: true, exported: format, resultId });
    } else {
      usage();
      process.exitCode = cmd === undefined ? 0 : 1;
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`输入被拒绝: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      throw err;
    }
  } finally {
    closeDatabase();
  }
}

const invoked = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  runCli(process.argv.slice(2));
}
