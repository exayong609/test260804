# 考试提交材料

本目录用于最终表格提交时的链接和文件索引：

- `考试提交汇总表.xlsx`：按考试提供的列结构整理的汇总表；部署完成后填写姓名、线上 URL 和实际仓库地址。
- `../test-data/10000-orders.xlsx`：10,000 行压测 Excel。
- `../test-data/sku-master-20000.csv`：20,000 条 SKU 主数据文件。
- `../docs/反思题.md`：反思题回答。
- `../docs/重构假设说明.md`：容量规划、幂等、降级、清理策略和产品问题清单。
- `../docs/压测报告.md`：真实 Vercel + PostgreSQL + Redis 压测数据待部署后补齐。
- `../docs/async-import-architecture.md`：异步事件驱动架构和运行边界。

当前本地 `npm run loadtest` 不能代替线上验收，因为没有配置真实 PostgreSQL、Redis 和 Worker。正式提交前需要把压测报告中的“待填写”字段替换为多轮实测结果，并把在线地址写回汇总表。
