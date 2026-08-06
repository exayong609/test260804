# V2 异步导入与可观测性

## 运行边界

- Vercel：页面、上传 API、状态/错误/Trace/监控查询。
- PostgreSQL：任务、原文件、处理单元、Outbox、错误、性能和 Trace。
- Redis + BullMQ：至少一次投递、失败重试和队列积压指标。
- 常驻 Worker：建议部署 Railway、Render 或 Fly.io，运行 `npm run worker`。

## 主链路

1. `POST /api/import-tasks` 接收文件和已保存的 V2 规则，只做轻量 Excel 行数预估；`file_hash` 命中历史任务时直接返回已有任务（重复上传去重）。
2. 任务、Outbox 事件和首个 Trace 事件以**单条 CTE SQL 一次往返**写入（同一事务语义不变）；原始文件在响应后由 `after()` 异步落库（`import_files`），Worker 遇到文件未就绪会按 BullMQ 退避自动重试。
3. Dispatcher 用 `FOR UPDATE SKIP LOCKED` 领取 Outbox 记录，按 `event_id` 作为 BullMQ `jobId` 投递。
4. 解析 Worker 调用现有 `parseUploadToDocument` 和 `executeRule`，持久化解析行并创建批次 Outbox 事件。
5. 批次 Worker 以 1,000 行为默认处理单元，批量查询 SKU 和历史外部编码，合法行按组批量 UPSERT，失败行批量写错误表。
6. 批次状态更新、运单写入、错误、性能日志和任务计数在同一事务完成；写入段耗时在事务后回填 `batch_performance_log.insert_duration_ms`。

## 可观测性接口

- `GET /api/import-monitor/summary`：实时吞吐、近 5 分钟吞吐序列、队列状态、四阶段 P50/P95/P99、错误分布、慢批次 TOP 10。
- `GET /api/traces?task_id=&trace_id=&file_name=&batch=&row_from=&row_to=&error_code=`：多维检索任务、时间线事件和行级错误。
- `GET /api/traces/:traceId`：单链路时间线。

## 上传接口预算（P95 ≤ 1s）

- 单往返 CTE（任务 + Outbox + Trace）：~250ms
- 规则按 id 直查（内置规则命中内存，0 往返）：~0-250ms
- 重复上传哈希去重（索引查询）：~80ms
- Excel 行数预估：~100-300ms
- 文件字节落库移出请求链路（`after()`），不计入响应
- Vercel Cron 每 5 分钟预热上传路由，抑制冷启动

## 幂等与恢复

- `task_id + unit_id` 唯一；只有 `pending` 批次能领取。
- BullMQ Job 使用 Outbox `event_id` 去重。
- 运单 ID 对有外部编码的数据使用稳定 SHA-256 业务键。
- 错误明细使用任务、处理单元、行号、字段和错误码唯一索引。
- 处理超过 5 分钟无完成记录的批次由恢复扫描重置为 `pending`。
- SKU 查询事务设置 3 秒 `statement_timeout`；超时进入显式降级并为每行记录 `W001`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `DATABASE_POOL_MAX` | 单进程连接池上限，默认 10 |
| `REDIS_URL` | BullMQ Redis 连接串 |
| `IMPORT_BATCH_SIZE` | 处理单元大小，默认 1000 |
| `IMPORT_WORKER_CONCURRENCY` | Worker 并发，默认 4 |
| `INTERNAL_API_KEY` | 内部 Dispatcher API 鉴权 |

## 验证

```bash
npm run seed:loadtest
npm run dev
npm run worker
APP_URL=http://127.0.0.1:3000 npm run loadtest
```

正式压测报告必须使用真实 PostgreSQL、Redis 和部署环境数据。无连接串时生成脚本只输出压测文件，不写入伪造结果。
