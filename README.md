# 依赖许可例外台

导入 CycloneDX SBOM，按政策判定组件许可（allow / deny / needs_exception / unknown），
跟踪有期限的许可例外，冻结发布候选并保存完整依赖图与逐项决议快照。

## 运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5235
```

打开 http://127.0.0.1:5235/ 。首次启动自动写入演示数据：
fixture 导入（含一条隔离组件）、政策集 v1、一条已到期的 LGPL 例外，
以及两个预置候选——`rc-2026.05`（例外到期前冻结，lgpl-widget 记为 allow_exception）
与 `rc-2026.09`（例外到期后冻结，同一组件变为 needs_exception），
并都包含一条传递拒绝路径 root-app → left-pad-utils → gpl-toolkit(GPL-3.0-only)。

## 设计要点

- **SPDX 结构化求值**（`src/spdx.ts`）：AND 取最差分支、OR 取最好分支，
  未知许可保持 unknown，绝不使用字符串包含匹配。
- **政策匹配**（`src/policy.ts`）：按许可 id、组件来源（purl type）、直接/传递依赖、
  用途、生效区间过滤；无匹配政策即 unknown。
- **例外**：绑定 purl + 版本 + 政策版本 + 用途，含理由、批准人、到期时刻；
  到期状态由查询时钟推导（`GET /api/exceptions/:id/status?at=...`），不做后台改写；
  更新走乐观锁（`version` 列），并发修改返回 409。
- **导入**（`src/importer.ts`）：单事务写入组件与依赖边，中途失败整体回滚；
  格式错误组件进隔离区，合法组件正常入库；隔离未处理前候选不能冻结；
  幂等键 + 内容哈希：相同内容重放原结果，不同内容 409。
- **冻结**（`src/candidates.ts`）：把依赖图与逐项决议快照进候选专属表，
  之后的政策/例外变化只影响新候选；导出只含摘要、依赖路径、决议与证据引用，
  不复制组件 properties。

## API 摘要

- `POST /api/imports`（头 `Idempotency-Key`，体为 CycloneDX JSON）
- `GET /api/imports/:id`、`POST /api/quarantine/:id/resolve`
- `GET|POST /api/policies`
- `GET|POST /api/exceptions`、`PUT /api/exceptions/:id`、`GET /api/exceptions/:id/status?at=`
- `POST /api/candidates`、`GET /api/candidates/:id`、`POST /api/candidates/:id/freeze`
- `GET /api/candidates/:id/trace/:ref`、`GET /api/candidates/:id/export`
