# V2 异步导入与可观测性

## 运行边界

- Vercel：页面、上传 API、状态/错误/Trace/监控查询。
- PostgreSQL：任务、原文件、处理单元、Outbox、错误、性能和 Trace。
- Redis + BullMQ：至少一次投递、失败重试和队列积压指标。
- 常驻 Worker：建议部署 Railway、Render 或 Fly.io，运行 `npm run worker`。

## 主链路

1. 浏览器先计算文件 SHA-256，再调用 `POST /api/import-tasks` 提交文件名、大小、指纹和规则；接口以**单条 CTE SQL 一次往返**完成重复检查、任务、Outbox 和首个 Trace 事件写入，立即返回 `task_id`。
2. 浏览器随后调用 `POST /api/import-tasks/:taskId/file` 上传原始文件。文件指纹复核、`import_files` 写入、Outbox 激活和 `ImportFilePersisted` Trace 在同一事务完成。Outbox 创建时先把 `next_retry_at` 延后，文件落库后再激活，Worker 不会抢跑。
3. Dispatcher 用 `FOR UPDATE SKIP LOCKED` 领取 Outbox 记录，按 `event_id` 作为 BullMQ `jobId` 投递。
4. 解析 Worker 调用现有 `parseUploadToDocument` 和 `executeRule`，持久化解析行并创建批次 Outbox 事件。
5. 批次 Worker 以 1,000 行为默认处理单元，批量查询 SKU 和历史外部编码，合法行按组批量 UPSERT，失败行批量写错误表。
6. 批次状态更新、运单写入、错误、性能日志和任务计数在同一事务完成；事务结束后回填真实写入耗时和包含写入阶段的总耗时。

## 可观测性接口

- `GET /api/import-monitor/summary`：实时吞吐、近 5 分钟吞吐序列、队列状态、四阶段 P50/P95/P99、错误分布、慢批次 TOP 10。
- `GET /api/traces?task_id=&trace_id=&file_name=&batch=&row_from=&row_to=&error_code=`：多维检索任务、时间线事件和行级错误。
- `GET /api/traces/:traceId`：单链路时间线。

## 上传接口预算（P95 ≤ 1s）

- 浏览器 SHA-256（1.5MB 文件）：通常低于 50ms
- 单往返 CTE（重复检查 + 任务 + Outbox + Trace）：目标 ~250-600ms
- 规则按 id 直查（内置规则命中内存，0 往返）：~0-250ms
- 数据库建表检查移出任务创建热路径
- 文件传输、Excel 解析和 `bytea` 落库在 `task_id` 返回后执行，不计入任务创建接口响应
- 兼容的 multipart 单接口仍保留，但量化验收使用两阶段接口，分别记录任务返回耗时和文件传输耗时

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
| `SERVERLESS_IMPORT_MAX_BYTES` | Vercel 小文件兜底上限，默认 512000；大文件交给常驻 Worker |

## 验证

```bash
npm run seed:loadtest
npm run dev
npm run worker
APP_URL=http://127.0.0.1:3000 npm run loadtest
```

正式压测报告必须使用真实 PostgreSQL、Redis 和部署环境数据。无连接串时生成脚本只输出压测文件，不写入伪造结果。
