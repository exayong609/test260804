# 考试提交材料

本目录用于最终表格提交时的链接和文件索引：

- `考试提交汇总表.xlsx`：按考试提供的列结构整理的汇总表；部署完成后填写姓名、线上 URL 和实际仓库地址。
- `../test-data/10000-orders.xlsx`：10,000 行压测 Excel。
- `../test-data/sku-master-20000.csv`：20,000 条 SKU 主数据文件。
- `../docs/反思题.md`：反思题回答。
- `../docs/重构假设说明.md`：容量规划、幂等、降级、清理策略和产品问题清单。
- `../docs/压测报告.md`：真实 Vercel + Neon PostgreSQL + Upstash Redis + Railway Worker 的 10,000 行压测证据。
- `../docs/async-import-architecture.md`：异步事件驱动架构和运行边界。
- `../docs/考试验收报告.md`：按考试考点整理的最终验收证据与现场展示检查清单。

线上地址、仓库、反思题、交付清单和 2026-08-07 两版本 fresh run 压测证据均已写入提交汇总表。最终推荐 `fix/main-exam-hardening`，实测评分 100/100；`fix/upload-p95-observability` 因上传超过 1 秒且文件未持久化不作为提交版本。压测环境未把数据库、Redis、LLM 或 Webhook 密钥写入仓库；运行时密钥仅配置在 Vercel / Railway 环境变量中。
