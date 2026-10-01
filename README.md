# 平面点集 Delaunay 三角剖分与矩形裁剪 Voronoi 后端

纯后端服务：输入带唯一编号的二维**整数**坐标点集，自行实现 Delaunay 三角剖分，
以及被指定矩形裁剪的 Voronoi 单元。仅提供 HTTP API 与 CLI，无网页、无地图、无三维。

- 语言/运行时：TypeScript + Node.js（建议 Node 22+，开发与验证环境为 Node 25）
- 数据库：SQLite，使用 Node 内置 `node:sqlite`（无需任何原生编译依赖）
- 平台：Windows 本地直接运行；不依赖 Docker、WSL、付费服务或外部在线 API
- 不调用任何现成三角剖分 / GIS 库，核心算法与精确谓词均在本仓库实现

## 坐标与规模约束

| 约束 | 值 | 非法时行为 |
| --- | --- | --- |
| 坐标范围 | `x,y ∈ [-1000000, 1000000]` 的整数 | 明确拒绝，返回 400 / CLI 非零退出并说明原因 |
| 点数上限（含重复坐标） | 10000 | 拒绝 |
| 裁剪矩形 | `maxX > minX` 且 `maxY > minY`，有限实数 | 零面积 / 反向 / 非有限值明确拒绝 |

浮点几何输出统一报告容差：`tolerance = 1e-9`（半平面裁剪松弛量），
面积与最近站点校验使用 `1e-7` 的比较容差。

## 退化输入的确定规则

1. **重复坐标**：相同 `(x,y)` 聚合为一个“站点”，站点保留全部来源编号
   （`sourceIds`，主编号取输入中第一个），不产生零面积三角形。
2. **三点共线 / 全部共线 / 唯一位置不足 3**：标记 `degenerate=true`，
   `triangles=[]`；凸包为沿直线方向排序的点链，点邻居为链上前后点；
   `degenerateReason` 给出中文原因。这不是错误，但不存在二维三角面。
3. **四点（多点）共圆**：圆内谓词采用“严格开圆”（圆上点 `incircle==0` 不触发空腔），
   插入顺序仅由坐标 `(x,y)` 字典序决定。共圆虽存在多个合法剖分，
   但仅修改输入编号（改名/乱序编号）不会改变几何结果。
4. 全部三角形顶点统一为逆时针（CCW，`orient>0`）；返回凸包边、
   边-三角形邻接、点邻居；无重复面、无交叉边、内部点不会遗漏。

## Voronoi 单元与三角剖分的关系

- 单元 = 裁剪矩形与“本站点相对其它每个站点的更近半平面（垂直平分线）”逐次求交。
- 真正约束某单元的站点一定是该站点的 **Delaunay 邻居**
  （结果中 `boundedBy` 为其邻居子集）；Delaunay 边与 Voronoi 边互为对偶。
- **等距边界归属规则**：垂直平分线上的等距点归“主来源编号字典序较小”的站点。
  交换两个站点的编号，铺满矩形的总面积不变，仅等距线归属侧翻转。
- **单元为空**（站点距矩形过远，被其它站点半平面完全排除）返回
  `empty=true, polygon=[], area=0`，这是合法结果；非法输入（非整数、越界、
  零面积矩形等）则被直接拒绝，二者在 API/CLI 层明确区分。

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build      # TypeScript -> dist/
npm test           # 构建并运行全部测试
npm run demo       # 导入->构网->插入新点->比较邻域->导出；含共线与拒绝示例
npm start          # 启动 HTTP 服务（默认端口 3000，数据目录 ./data）

# 自定义端口与数据目录
$env:PORT='8080'; $env:DATA_DIR="$PWD\data"; npm start
node dist/src/server.js --port=8080
```

## CLI

构建后入口为 `node dist/src/cli.js ...`（可 `npm link` 得到 `triang` 命令）。

```powershell
node dist/src/cli.js import --name demo --file demo/points.json
node dist/src/cli.js list
node dist/src/cli.js build --pointset 1
node dist/src/cli.js build --pointset 1 --rect "-2,-2,12,12" --out result.json
node dist/src/cli.js append --pointset 1 --file demo/new-point.json --name demo-v2
node dist/src/cli.js compare --result 1 --result 2
node dist/src/cli.js query-cell --result 1 --source-id S005-DUP
node dist/src/cli.js export --result 2 --format csv --kind cells --out cells.csv
node dist/src/cli.js list --db E:\my\data.db
```

点文件 JSON 格式：`[{"id":"S001","x":0,"y":0}, ...]`；
CSV 首行为 `id,x,y`，允许重复坐标（编号必须唯一）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与公开约束（maxCoord/maxPoints） |
| POST | `/api/pointsets` | 幂等导入点集（内容哈希去重） |
| GET | `/api/pointsets` | 列出点集版本 |
| POST | `/api/pointsets/{id}/append` | 追加点，产生新的冻结点集版本 |
| POST | `/api/pointsets/{id}/triangulate` | Delaunay 剖分（幂等保存结果） |
| POST | `/api/pointsets/{id}/voronoi` | 剖分 + 矩形裁剪 Voronoi |
| GET | `/api/results?pointsetId=` | 列出结果版本 |
| GET | `/api/results/{id}?format=csv&kind=cells` | 读取结果（JSON/CSV） |
| GET | `/api/results/{id}/export?format=json\|csv` | 导出结果 |
| POST | `/api/cells/query` | 按 `resultId + sourceId`（或 siteIndex）查询单元 |
| POST | `/api/neighborhoods/compare` | 比较 `resultIdA/resultIdB` 的点邻居差异 |

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/pointsets `
  -ContentType 'application/json' `
  -Body (@{name='demo'; points=(Get-Content demo/points.json -Raw | ConvertFrom-Json)} | ConvertTo-Json)

Invoke-RestMethod -Method Post http://localhost:3000/api/pointsets/1/voronoi `
  -ContentType 'application/json' `
  -Body '{"minX":-2,"minY":-2,"maxX":12,"maxY":12}'
```

## 版本与幂等（SQLite）

- `pointsets`：点集内容哈希唯一；重复导入返回同一条记录。
- `boundaries`：点集 + 矩形哈希唯一。
- `results`：点集 + 裁剪矩形 + 算法配置三元组唯一；重复请求不产生重复结果。
- “插入新点”通过 `append` 生成全新点集版本，旧点集与其结果被冻结、不受影响。

## 正确性如何被验证

独立校验器 `src/verify.ts` 只消费“输入点 + 输出结果”，不信任算法内部：

- 每个三角形：BigInt 精确方向（全部 CCW）与空开外接圆（其余站点不在圆内）；
  无重复面；三角形有向面积之和（BigInt）等于凸包多边形面积；
  凸包边与“仅出现一次的三角边”集合一致。
- Voronoi：非空单元面积之和等于矩形面积（误差阈值内）；
  对每个单元内部样点及覆盖矩形的网格点，核对其归属单元就是最近站点
  （等距点按编号字典序的归属规则）。

测试覆盖：单三角形、正方形共圆、正方形含中心点、长条近共线、严格共线、
重复坐标、非法坐标/编号、零面积矩形、单元面积与最近站点、版本冻结与幂等。
另对 200 组随机点集与极端坐标做了空圆 / 方向 / 面积 / 凸包核对。

## 目录

```
src/geometry.ts  精确谓词(orient/inCircle, BigInt) + Bowyer-Watson 剖分/凸包/邻接
src/voronoi.ts   垂直平分线半平面裁剪 + 等距归属 + 矩形校验
src/service.ts   输入校验、构网、邻域比较、JSON/CSV 导出
src/store.ts     SQLite 表结构、冻结版本、幂等读写
src/server.ts    HTTP API
src/cli.ts       CLI
src/verify.ts    独立校验器
test/            node:test 测试
demo/            样例数据与端到端演示
data/            运行期 SQLite 数据目录（自动创建）
```

## 算法与实现说明

- 剖分采用 Bowyer-Watson 增量插入：构造必含全部点的大超级三角形，
  逐点删除外接开圆包含该点的三角形，沿空腔边界重新连面，最后剔除超级顶点。
- `orient` 与 `inCircle` 全程 BigInt（坐标为整数），不存在浮点误判；
  超级三角形尺度约为包围盒的 20 倍以上，谓词值仍在 BigInt 精度内。
- Voronoi 裁剪对每个单元做 O(n) 半平面求交（整体 O(n^2)），
  使用 Sutherland-Hodgman 式多边形裁剪。

## 限制与合理假设

- 规模定位为“小规模”：默认上限 10000 点；Voronoi 为 O(n^2)，
  上万站点的全量单元构建可能较慢（三角剖分本身为增量实现）。
- 坐标必须是整数（精确谓词前提）；裁剪矩形可为实数。
- 仅平面欧氏坐标；不支持地图投影、三维、栅格或可视化界面。
- Node 内置 SQLite 会打印 `ExperimentalWarning`，功能正常，不影响数据正确性。
- 全共线 / 不足 3 点被视为合法退化输入（返回链与原因），而非服务错误。
