# 考试提交材料

本目录用于最终表格提交时的链接和文件索引：

- `考试提交汇总表.xlsx`：最终提交表，已更新为正式生产域名、`main` 分支和生产合并提交 `8d90ec2`，并保留 2026-08-07 最新线上实测证据。
- `../test-data/10000-orders.xlsx`：10,000 行压测 Excel。
- `../test-data/sku-master-20000.csv`：20,000 条 SKU 主数据文件。
- `../docs/反思题.md`：反思题回答。
- `../docs/重构假设说明.md`：容量规划、幂等、降级、清理策略和产品问题清单。
- `../docs/压测报告.md`：Vercel + Neon PostgreSQL + Upstash Redis + Railway Worker 的真实 UI/任务压测证据。
- `../docs/async-import-architecture.md`：异步事件驱动架构和运行边界。
- `../docs/考试验收报告.md`：两套考纲的逐项证据、评分与扣分清单。

正式提交 `main`，生产地址为 https://test260804-exayong-1502s-projects.vercel.app/import-tasks。异步专项口径为 100/100；原始 V2 HTML 的明细实际为 110 分，当前可证实 100/110，折算 90.9/100。三份缺失原件未冒充实测，移动端也未冒充独立浏览器验收。数据库、Redis、LLM 与 Webhook 密钥均未写入仓库；DeepSeek Key 仅保存在服务端配置中，外部告警 Webhook 当前未配置。
