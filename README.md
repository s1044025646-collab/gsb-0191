# 平面点集 Delaunay 三角剖分与裁剪 Voronoi 后端

面向小规模二维整数坐标点集的几何构网服务：管理点集与裁剪矩形，自行实现
Delaunay 三角剖分核心（BigInt 精确谓词），生成被轴对齐矩形裁剪的 Voronoi
单元，提供 HTTP API 与命令行（CLI），结果以 SQLite 冻结并幂等缓存。

仅后端、仅平面欧氏坐标；不含地图投影、三维曲面、图片处理或网页界面。
不依赖任何现成三角剖分/GIS 库，也不依赖 Docker、WSL、付费服务或在线 API。

## 运行环境

- Windows + PowerShell，Node.js `>= 22.5`（开发与实测版本 Node v25.5.0）。
- SQLite 使用 Node 内置的 `node:sqlite`，无需原生编译；运行时会出现一次
  `SQLite is an experimental feature` 警告，属正常现象。
- 唯一的开发依赖为 `typescript` 与 `@types/node`。

## 快速开始

```powershell
npm install        # 安装 TypeScript 等开发依赖
npm run build      # 编译到 dist/
npm test           # 运行全部测试（node --test）
npm run demo       # 构建并运行端到端演示（导入/构网/插入/比较/导出/拒绝非法输入）
npm start          # 启动 HTTP API，默认 http://localhost:3000
```

可配置端口与项目内数据目录：

```powershell
$env:PORT="8080"
$env:DATA_DIR="$PWD\data"   # 默认就是项目内 .\data
npm start
```

冒烟脚本（真实起服务 / 真实读写数据库）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-api.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-cli.ps1
```

## 输入限制（公开并强制执行）

| 项目 | 取值 |
| --- | --- |
| 坐标类型 | 整数 |
| 坐标范围 | `[-1,000,000, 1,000,000]` |
| 单次来源点数上限 | `5000` |
| 裁剪矩形 | 整数坐标，必须严格正面积（`xmax > xmin` 且 `ymax > ymin`） |
| 几何容差（浮点输出） | `1e-9`，随每次结果返回 `tolerance` |

明确拒绝（HTTP 返回 `422`，CLI 退出码 `2` 并打印中文原因）：
非整数/越界坐标、空点集、重复来源编号、零面积或倒置裁剪矩形、矩形坐标非整数。

## 退化输入的确定规则

- **去重**：同一整数坐标的多个来源编号合并为一个“唯一站点”，全部来源编号
  按导入顺序保留；构网只针对唯一站点。
- **规范化顺序**：站点按坐标字典序 `(x, y)` 编号并按该顺序插入，因此
  **改变用户编号或导入顺序不会改变几何结果**（测试中有专门断言）。
- **三点共线 / 边上插入点**：不会生成退化（零面积）三角形；点落在内部
  边上时，该边两侧的三角形共同作为空腔种子，等价于把该边在该点处分裂。
- **全部共线**：不产生三角形（`collinear=true`），凸包退化为连接两个
  端点的一条线段，点邻居按线上次序给出，Voronoi 仍可正常构建。
- **四点共圆**：共圆点满足 `incircle = 0` 也被纳入空腔并整体重连，收敛为
  “以最后插入的规范化站点为扇形中心”这一确定且合法的 Delaunay 剖分；
  正方形共圆的两条对角线都是合法解，这里固定其中一条。
- **精确谓词**：方向 `orient2d` 与圆内 `incircle` 全部用 BigInt 计算，
  不使用随机扰动、不依赖浮点 epsilon 判定拓扑。
- **输出统一**：所有三角形统一为逆时针（CCW），边为无向边（小编号在前）。

## Voronoi 单元与三角剖分的关系

Voronoi 图是 Delaunay 三角剖分的直线对偶：

- 每条 Delaunay 边对应一条 Voronoi 边（位于该边的垂直平分线上）；
- 每个 Delaunay 三角形的外接圆圆心是一个 Voronoi 顶点；
- 站点 `i` 的裁剪单元 = 裁剪矩形与
  `⋂_{j 为 i 的 Delaunay 邻居} H(i,j)` 的交集，
  其中 `H(i,j) = { x : |x - Pi|² <= |x - Pj|² }`，
  用 Sutherland–Hodgman 对半平面逐个求交。

边界等距点归属规则：`lower-site`，平分线上的点在归属抽样中归站点序号
较小者；单元之间只共享零面积边界，采用闭半平面裁剪。

- 站点位于裁剪矩形外时其单元可能为**空单元**（`empty=true, area=0`），
  这是合法几何结果；它与“非法输入被拒绝”是两回事。
- 浮点顶点/面积均以容差 `1e-9` 报告；校验器会核对所有非空单元面积之和
  等于矩形面积，并在矩形内规则网格抽样确认样点属于最近站点。

## HTTP API

所有请求/响应均为 JSON。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查、端口与数据目录 |
| `POST /point-sets` | 创建点集 `{name, points:[{id,x,y}]}` |
| `GET /point-sets` | 列出点集 |
| `GET /point-sets/:id` | 点集详情 |
| `POST /point-sets/:id/points` | 追加来源点（不影响已冻结旧结果） |
| `POST /point-sets/:id/triangulate` | 构网 `{bounds, config?}`，幂等 |
| `GET /results/:id` | 取完整结果 |
| `GET /results/:id/cell?siteIndex=` 或 `&sourceId=` | 查询单个裁剪单元 |
| `GET /results/:id/compare` 之外的比较：`POST /results/compare` | 比较两次结果的点邻域 `{beforeResultId, afterResultId}` |
| `GET /results/:id/export?format=json|csv` | JSON / CSV 导出 |
| `GET /results/:id/verify` | 独立校验（空圆、方向、面积、最近站点抽样） |
| `POST /compute` | 无状态即算（不落库），便于快速验证 |

构网响应包含 `created`（首次 `true`，相同输入重复请求 `false`）与
`resultId`；结果内容包含三角剖分、凸包、边邻接、点邻居、裁剪 Voronoi
单元、去重映射、容差与输入统计。

### 邻域比较

`POST /results/compare` 返回：

- `addedPoints`：新增来源点；
- `addedNeighborEdges` / `removedNeighborEdges`：Delaunay 点邻居边的增删；
- `changedSites`：邻接关系发生变化的站点序号。

## CLI

```powershell
npm run build
node dist/src/cli.js point-set create --name demo --points @points.json
node dist/src/cli.js point-set list
node dist/src/cli.js point-set add-points --id 1 --points @more.json
node dist/src/cli.js triangulate --id 1 --bounds '@{"xmin":-1,"ymin":-1,"xmax":5,"ymax":5}'
node dist/src/cli.js result get --result 1
node dist/src/cli.js result cell --result 1 --source-id A
node dist/src/cli.js result compare --before 1 --after 2
node dist/src/cli.js result export --result 1 --format json --out result.json
node dist/src/cli.js result export --result 1 --format csv  --out result   # 生成 result.<表>.csv
```

`@文件` 表示从文件读取 JSON；边界/配置也可直接传 JSON 字符串。
数据库路径可用环境变量 `GSB_DB` 覆盖，否则使用 `%DATA_DIR%\app.db`。

## SQLite：冻结与幂等

数据表：`point_sets`、`bounds_versions`、`config_versions`、`results`。

- 每次构网以“点集内容 + 边界 + 配置”的 SHA-256 作为 `input_hash`，
  数据库对其建唯一约束：**重复请求返回同一 `resultId`，不产生重复结果**。
- 结果行保存完整 JSON 快照及其生成时的边界/配置版本；随后向点集追加新点
  会改变内容哈希、产生新结果行，而**旧结果保持不变**。

## 项目结构

```
src/
  constants.ts            # 公开限制与容差
  types.ts                # 数据类型与默认配置
  validate.ts             # 输入校验、去重映射
  geometry/
    predicates.ts         # BigInt orient2d / incircle
    hull.ts               # 精确单调链凸包、共线判定
    delaunay.ts           # 自行实现的 Bowyer–Watson（含退化处理）
    voronoi.ts            # 半平面裁剪 Voronoi 单元
    verify.ts             # 独立校验器（空圆/方向/面积/抽样）
  db.ts                   # node:sqlite 建表与连接
  service.ts              # 构网编排、幂等、邻域比较
  exporters.ts            # JSON / CSV 导出
  server.ts  cli.ts  demo.ts
test/                     # node:test 单元 + SQLite 集成测试
scripts/                  # Windows 冒烟脚本
data/                     # 默认数据目录（SQLite）
```

## 测试覆盖了什么

`npm test` 不只是数三角形个数，还通过 `verify.ts` 独立核对：

- 单三角形、正方形共圆（且编号/导入顺序改变结果不变）、含中心点、
  长条近共线、重复位置、全共线；
- 每个三角形对其余所有站点满足**严格空外接圆**（共圆允许）；
- 每个三角形严格 CCW、无重复面、无非相邻交叉边；
- 三角形有向面积（2 倍）之和精确等于凸包（2 倍）面积（BigInt）；
- 裁剪单元面积总和等于矩形面积；网格抽样点全部属于最近站点；
- 空单元与非法输入的区分；SQLite 幂等与旧结果冻结。

## 已知限制与假设

- 仅支持轴对齐矩形裁剪与整数输入坐标；浮点仅用于 Voronoi 顶点/面积输出。
- 规模定位为小规模点集（上限 5000 点）；当前实现未做多级空间索引，
  超大点集的构网耗时会明显增长。
- 全共线点集不定义二维三角剖分，按上述退化规则返回空三角形集合。
- 共圆情形存在多个合法剖分，本服务按规范化顺序固定其中之一。
