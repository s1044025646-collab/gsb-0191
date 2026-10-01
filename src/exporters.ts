import type { ComputePayload } from "./service.js";

/** 导出完整结果为 JSON 字符串。 */
export function exportJson(payload: ComputePayload): string {
  return JSON.stringify(
    {
      tolerance: payload.tolerance,
      input: payload.input,
      bounds: payload.bounds,
      config: payload.config,
      sites: payload.sites,
      triangulation: payload.triangulation,
      voronoi: payload.voronoi,
    },
    null,
    2,
  );
}

function csvCell(v: unknown): string {
  const s = String(v);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows: Array<Array<unknown>>, header: string[]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

export interface CsvBundle {
  points: string;
  triangles: string;
  hull: string;
  neighbors: string;
  voronoi_cells: string;
}

/** 分表导出 CSV（多个逻辑表各自成串）。 */
export function exportCsv(payload: ComputePayload): CsvBundle {
  const pointRows = payload.sites.map((s) => [
    s.siteIndex,
    s.x,
    s.y,
    s.sourceIds.join("|"),
  ]);

  const triRows = payload.triangulation.triangles.map((t, i) => [
    i,
    t.sites[0],
    t.sites[1],
    t.sites[2],
  ]);

  const hullRows = payload.triangulation.hull.map((e, i) => [i, e.a, e.b]);

  const neighborRows: Array<Array<unknown>> = [];
  for (const [site, nbs] of Object.entries(payload.triangulation.neighbors)) {
    neighborRows.push([site, nbs.join("|")]);
  }
  neighborRows.sort((a, b) => Number(a[0]) - Number(b[0]));

  const cellRows = payload.voronoi.map((c) => [
    c.siteIndex,
    c.empty ? 1 : 0,
    c.siteInsideBounds ? 1 : 0,
    c.area.toFixed(12),
    c.polygon.map((p) => `${p.x.toFixed(9)}:${p.y.toFixed(9)}`).join("|"),
  ]);

  return {
    points: toCsv(pointRows, ["site_index", "x", "y", "source_ids"]),
    triangles: toCsv(triRows, ["triangle_index", "site_a", "site_b", "site_c"]),
    hull: toCsv(hullRows, ["edge_index", "site_a", "site_b"]),
    neighbors: toCsv(neighborRows, ["site_index", "neighbor_site_indices"]),
    voronoi_cells: toCsv(cellRows, [
      "site_index",
      "empty",
      "site_inside_bounds",
      "area",
      "polygon_xy_vertices",
    ]),
  };
}
