# 依赖许可例外台 (License Exception Desk)

面向工程合规组的本地工作台：导入软件物料清单（CycloneDX JSON），解释每个组件
为何能进入某次发布，并跟踪**有期限**的许可例外。TypeScript 服务 + 网页，
SQLite（Node 内置 `node:sqlite`）持久化。

## 安装与运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5235
```

打开 http://127.0.0.1:5235 ，页面标题为 **依赖许可例外台**。首次启动会自动
播种政策、fixture 与预置候选（数据库文件在 `data/license-desk.sqlite`，删除即重置）。

## 预置演示

固定演示时间线（可在左下角“查询时钟”里改时间观察状态推导）：

- `payments-rc1`（2026-03-01 冻结）：含一条**传递拒绝路径**
  `payments-app → express → loglib → readline-gpl (GPL-3.0-only)`，依据 `P-GPL v1 → deny`。
- `payments-rc2-exception`（2026-05-15 例外生效期冻结）：同一 GPL 组件因
  绑定身份 + 政策版本的例外而 **allow**，冻结后结论固化。
- `payments-rc3-after-expiry`（草稿，查询时钟 2026-09-30）：例外已于
  2026-06-01 到期，新候选结论回到 **deny** —— 展示“到期后新旧结论差异”，
  且历史冻结不被改写。
- `shipping-blocked`：导入含格式错误组件（缺 purl / 非法 SPDX 表达式），
  进入隔离区且未处理前**不能冻结**（接口返回 409）。
- `gateway-samename`：两个同名 `widget`、不同 purl/版本，分别 allow / deny。

## 核心规则

- **结构化 SPDX**：`AND`/`OR` 解析成 AST（AND 优先级高于 OR），按 DNF 三值逻辑
  （true / false / unknown）判定，绝不使用字符串包含；未知许可保持 `unknown`。
- **政策维度**：许可表达式、组件来源（external/internal）、直接/传递、用途、
  生效区间（半开 `[from, to)`）共同决定 `allow / deny / needs_exception`。
- **例外身份**：绑定 purl(+版本) 与用途、政策版本、理由、批准人、到期时刻；
  到期时刻本身即视为已到期；状态由查询时钟推导，无后台任务改历史。
- **冻结快照**：冻结时保存完整依赖图、逐项决议、政策版本与时钟；之后政策或
  例外变化只影响新草稿/新候选。
- **并发**：例外行带 `row_version` 乐观锁，并发的陈旧写入返回 409。
- **幂等导入**：导入键（默认 CycloneDX `serialNumber@version`）+ 内容 SHA-256；
  同键同内容返回原结果，同键不同内容 409。
- **原子导入**：组件与边在同一事务写入；进程在中途退出会整体回滚，不留半张图。
- **导出**：仅含候选摘要、依赖路径、逐项决议与证据引用；**不包含**可能藏有
  秘密的组件 `properties`。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/imports?key=&clock=` | 导入 CycloneDX JSON（幂等/冲突） |
| GET | `/api/quarantine` · POST `/api/quarantine/:id/resolve` | 隔离区与处置 |
| GET/POST | `/api/policies` · `/api/exceptions` | 政策与例外 |
| PATCH | `/api/exceptions/:id` | 乐观锁更新（需 `expectedRowVersion`） |
| GET/POST | `/api/candidates` · `/api/candidates/:id/freeze` | 候选与冻结 |
| GET | `/api/candidates/:id/export?clock=` | 安全导出（无 properties） |

所有查询接受 `?clock=<ISO8601>` 用于复现到期/政策生效区间。

## 测试

`npm test -- --run`（Vitest，33 个用例）覆盖：AND/OR 结构匹配、unknown、
同名不同 purl、传递路径、到期端点（半开）、冻结隔离门、并发例外版本冲突，
以及组件与边之间真实进程退出的事务回滚。
