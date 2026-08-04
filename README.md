# 万能导入 V2

智能多格式批量下单系统，基于 Next.js App Router + TypeScript，面向 Excel、Word、PDF 等复杂出库单导入。

## 功能覆盖

- 文件上传：支持 `.xlsx`、`.xls`、`.docx`、`.pdf`。
- 规则管理：创建、编辑、保存、复制、删除，规则持久化到服务端数据库。
- AI 辅助生成：上传样例文件后，大模型生成可编辑的解析规则 JSON；用户预解析、微调、确认后保存。
- 规则引擎：解析过程执行通用规则，不为每个 demo 写 if-else。
- 模型 Profile：数据库保存大模型 API URL、Key、模型名、协议、温度、超时，支持新增、编辑、删除、测试连接。
- 复杂结构：支持头部跳过、尾部信息提取、跨行聚合、矩阵转置、多 Sheet、卡片式拆分、复合单元格拆分、Word/PDF 文本解析。
- 预览编辑：类 Excel 表格、表头固定、横向滚动、虚拟列表、单元格编辑、新增行、删除行。
- 校验：SKU 必填、数量正数、电话格式、A/B 收货信息二选一、批次内重复、历史重复。
- 导出：预览数据可导出为 `.xlsx`。
- 提交：校验通过后按外部编码聚合 SKU，写入数据库。
- 历史：已导入列表支持搜索、分页和详情查看。

## 本地运行

```bash
npm install
npm run dev
```

默认地址：

```bash
http://127.0.0.1:3000
```

## 环境变量

复制 `.env.example` 为 `.env.local`：

```bash
DATABASE_URL=
NEXT_PUBLIC_DATABASE_LABEL=Vercel Marketplace DB
LLM_API_KEY=
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_PROTOCOL=openai-compatible
```

说明：

- `DATABASE_URL`：Neon / Supabase 等 Postgres 连接串。项目在没有数据库时会回退到 `data/local-store.json`，但正式提交建议使用数据库。
- `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`LLM_PROTOCOL`：环境变量兜底模型配置。
- 更推荐在页面的“模型配置”中维护 Profile，Profile 会保存到数据库，支持 MiniMax 原生协议。

MiniMax 原生配置示例：

```bash
protocol=minimax-native
baseUrl=https://api.minimaxi.com/v1/text/chatcompletion_v2
model=MiniMax-M3
```

## 大模型设计

模型调用集中在 `src/lib/llm.ts`。系统不是让 AI 直接输出订单数据，而是让 AI 输出 `ParsingRule`：

- 系统提示词要求模型扮演“解析规则设计助手”。
- 用户消息只发送压缩结构样本：sheet 头尾行、文本头尾、统计信息、本地推荐规则和本地规则试解析指标。
- 模型必须返回合法 JSON，字段和 mapping kind 只能使用白名单。
- 模型必须填写 `assumptions`，标注推测映射，交给用户最终确认。
- 服务端会用当前文件对 AI 规则自检；如果 0 行、错误更多、关键字段缺失、分组异常或明显过度抽取，就自动回退到本地推荐规则。

详细说明见：

- `docs/usage-guide.md`
- `docs/ai-and-rules.md`
- `docs/prompt-verification-report.md`

## 验证命令

```bash
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run demo:rules
```

## 异步导入与全链路观测

访问 `/import-tasks` 可创建异步导入任务并查看进度、行级错误、批次性能和 Trace。该链路复用现有文件解析器与规则引擎，并通过 PostgreSQL Transactional Outbox + BullMQ Worker 执行。

```bash
npm run seed:loadtest  # 20,000 SKU + 10,000 行 Excel
npm run worker         # 常驻消费者与 Outbox Dispatcher
npm run loadtest       # 上传、轮询、60 秒目标判定
```

架构、幂等、降级和部署边界详见 `docs/async-import-architecture.md`。

`npm run smoke` 会检查：

- 首页和 `/api/health`
- 默认规则模板
- demos 目录真实文件解析
- 多 Sheet、矩阵、卡片、Word 纯文本、多订单文本
- 1000 行性能
- Excel 导出
- 提交下单和历史查询

最近一次本地结果：

- 真实 demos 6 个文件全部解析成功，0 个校验问题。
- 1000 行标准 Excel 解析为 1000 行，规则引擎约 15ms，接口往返小于 1 秒。
- MiniMax Profile 连接测试通过；真实 demos 6 个文件均已走过“模型生成规则 + 规则自检 + 解析”链路：5 个直接采用 LLM 规则，1 个因模型少抽 1 行被质量闸门安全回退，最终解析结果均为 0 个校验问题。

### demos 文件与内置模板对应关系

| demo 文件 | 推荐内置模板 | 回测结果 |
| --- | --- | --- |
| `12.25海口龙湖天街-配送发货单PS2512220005001(1).xlsx` | `内置｜标准配送单：表头明细 + 尾部收货` | 2 行，0 个校验问题 |
| `湖南仓.xlsx` | `内置｜汇总明细表：逐行收货字段` | 167 行，0 个校验问题 |
| `多门店分Sheet出库单.xlsx` | `内置｜多 Sheet 出库单：Sheet 合并 + 尾部收货` | 21 行，0 个校验问题 |
| `欢乐牧场模板0430.xlsx` | `内置｜门店矩阵：SKU 行 x 门店列` | 15 行，0 个校验问题 |
| `门店调拨单-卡片式.xlsx` | `内置｜卡片式调拨：区块拆分 + 小表明细` | 9 行，0 个校验问题 |
| `黔寨寨贵州烙锅（鞍山店）常温.pdf` | `内置｜PDF 编号文本：跨行规格明细` | 41 行，0 个校验问题 |

补充说明：`门店调拨单-卡片式.xlsx` 的 9 行明细数量合计为 39，源文件页脚写“总调拨数量：44”，两者不一致；系统按可见 SKU 明细解析，没有用页脚汇总倒推补行。PDF 文件不是 39 行，`黔寨寨贵州烙锅（鞍山店）常温.pdf` 回测为 41 行，数量合计 350。

## Vercel 部署

1. 推送代码到 GitHub。
2. 在 Vercel 导入仓库。
3. 配置 `DATABASE_URL`。
4. 部署后打开页面，配置或检查模型 Profile。
5. 访问 `/api/health`，确认 `ok: true`、`storage: database`。
6. 上传 demos 文件，检查 AI 生成规则、预解析、解析全部、提交和历史列表。

完整使用、部署、模型配置和 9 类场景规则样例见 `docs/usage-guide.md`。
