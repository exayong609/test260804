"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  FileSpreadsheet,
  Gauge,
  Loader2,
  Network,
  RefreshCw,
  Search,
  UploadCloud
} from "lucide-react";
import { errorAdvice } from "@/lib/import-error-advice";
import { sha256Blob } from "@/lib/file-fingerprint";
import type { ParsingRule } from "@/types";

type TaskStatus = "pending" | "processing" | "completed" | "partial_success" | "failed";
type Task = {
  task_id: string;
  trace_id: string;
  file_name: string;
  status: TaskStatus;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  degraded: boolean;
  created_at: string;
};
type ImportError = {
  id: number;
  unit_id: string;
  batch_index: number;
  row_number: number;
  field_name: string;
  raw_value: string;
  error_code: string;
  error_reason: string;
};
type Batch = {
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  status: string;
  retry_count: number;
  result_success_rows: number;
  result_failed_rows: number;
  validate_duration_ms?: number;
  insert_duration_ms?: number;
  total_duration_ms?: number;
};
type TraceEvent = {
  event_name: string;
  event_status: string;
  task_id?: string;
  unit_id?: string;
  message: string;
  occurred_at: string;
};
type SlowBatch = {
  task_id: string;
  file_name: string | null;
  unit_id: string;
  batch_index: number;
  validate_duration_ms: number;
  insert_duration_ms: number;
  total_duration_ms: number;
};
type Monitor = {
  throughput_per_minute: number;
  throughput_series: Array<{ minute: string; rows: number }>;
  queue: Array<{ status: string; units: number; rows: number }>;
  latency: Record<string, number | null>;
  errors: Array<{ error_code: string; count: number }>;
  slow_batches: SlowBatch[];
};
type TraceSearchResult = {
  tasks: Task[];
  events: TraceEvent[];
  errors: Array<ImportError & { task_id: string; trace_id: string }>;
};

const statusText: Record<TaskStatus, string> = {
  pending: "等待处理",
  processing: "处理中",
  completed: "已完成",
  partial_success: "部分成功",
  failed: "失败"
};

const ERROR_PAGE_SIZE = 50;

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

export default function ImportTasksPage() {
  const [rules, setRules] = useState<ParsingRule[]>([]);
  const [ruleId, setRuleId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [errorPage, setErrorPage] = useState(1);
  const [errorCode, setErrorCode] = useState("");
  const [errorBatch, setErrorBatch] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [monitorDown, setMonitorDown] = useState(false);
  const [traceQuery, setTraceQuery] = useState({ task_id: "", trace_id: "", file_name: "", batch: "", error_code: "", row_from: "", row_to: "" });
  const [traceResult, setTraceResult] = useState<TraceSearchResult | null>(null);
  const [traceSearching, setTraceSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<"work" | "monitor">("work");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");

  const selected = useMemo(() => tasks.find((task) => task.task_id === selectedId) ?? tasks[0], [tasks, selectedId]);

  const loadTasks = useCallback(async () => {
    try {
      const data = await readJson<{ items: Task[] }>(await fetch("/api/import-tasks", { cache: "no-store" }));
      setTasks(data.items);
      setSelectedId((current) => current || data.items[0]?.task_id || "");
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "任务加载失败。");
    }
  }, []);

  const loadDetail = useCallback(async (task: Task, page: number, code: string, batch: string) => {
    const query = new URLSearchParams({ error_code: code, page: String(page), page_size: String(ERROR_PAGE_SIZE) });
    if (batch) query.set("batch", batch);
    const [errorResult, batchResult, traceResult] = await Promise.allSettled([
      readJson<{ items: ImportError[]; total: number }>(await fetch(`/api/import-tasks/${task.task_id}/errors?${query}`, { cache: "no-store" })),
      readJson<{ items: Batch[] }>(await fetch(`/api/import-tasks/${task.task_id}/batches`, { cache: "no-store" })),
      readJson<{ events: TraceEvent[] }>(await fetch(`/api/traces/${task.trace_id}`, { cache: "no-store" }))
    ]);
    if (errorResult.status === "fulfilled") {
      setErrors(errorResult.value.items);
      setErrorTotal(errorResult.value.total);
    }
    if (batchResult.status === "fulfilled") setBatches(batchResult.value.items);
    if (traceResult.status === "fulfilled") setTrace(traceResult.value.events);
  }, []);

  const loadMonitor = useCallback(async () => {
    try {
      setMonitor(await readJson<Monitor>(await fetch("/api/import-monitor/summary", { cache: "no-store" })));
      setMonitorDown(false);
    } catch {
      setMonitor(null);
      setMonitorDown(true);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      fetch("/api/rules").then((response) => readJson<{ rules: ParsingRule[] }>(response)).then((data) => {
        setRules(data.rules);
        setRuleId(data.rules[0]?.id || "");
      }),
      loadTasks(),
      loadMonitor()
    ]);
  }, [loadMonitor, loadTasks]);

  useEffect(() => {
    if (selected) void loadDetail(selected, errorPage, errorCode, errorBatch);
  }, [loadDetail, selected, errorPage, errorCode, errorBatch]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTasks();
      void loadMonitor();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [loadMonitor, loadTasks]);

  async function uploadTaskFile(taskId: string, fingerprint: string, sourceFile: File) {
    const started = performance.now();
    try {
      const form = new FormData();
      form.set("file", sourceFile);
      form.set("fileHash", fingerprint);
      await readJson<{ uploaded: boolean }>(await fetch(`/api/import-tasks/${taskId}/file`, { method: "POST", body: form }));
      setNotice(`文件上传完成（${Math.round(performance.now() - started)}ms），异步处理已激活。`);
      await loadTasks();
    } catch (error) {
      setNotice(error instanceof Error ? `任务已创建，但文件上传失败：${error.message}` : "任务已创建，但文件上传失败。");
    }
  }

  async function createTask() {
    if (!file || !ruleId) return;
    setBusy(true);
    setNotice("");
    try {
      const started = performance.now();
      const fingerprint = await sha256Blob(file);
      const task = await readJson<Task & { upload_duration_ms?: number; duplicated?: boolean; file_upload_pending?: boolean; notice?: string }>(await fetch("/api/import-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          fileHash: fingerprint,
          estimatedRows: 0,
          ruleId
        })
      }));
      setSelectedId(task.task_id);
      setErrorPage(1);
      if (task.file_upload_pending) {
        setNotice(task.duplicated
          ? "已找到上次未完成上传的任务，正在继续上传文件。"
          : `任务已创建：接口 ${task.upload_duration_ms ?? 0}ms，客户端 ${Math.round(performance.now() - started)}ms；文件正在后台上传。`);
        void uploadTaskFile(task.task_id, fingerprint, file);
      } else {
        setNotice(task.notice ?? "相同文件已导入，已定位到已有任务。");
      }
      await loadTasks();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务创建失败。");
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    if (!selected) return;
    try {
      const result = await readJson<{ retried: number }>(await fetch(`/api/import-tasks/${selected.task_id}/retry`, { method: "POST" }));
      setNotice(`已重新入队 ${result.retried} 个失败批次。`);
      await loadTasks();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "失败批次重试失败。");
    }
  }

  async function runTraceSearch() {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(traceQuery)) if (value.trim()) query.set(key, value.trim());
    if (![...query.keys()].length) return;
    setTraceSearching(true);
    try {
      setTraceResult(await readJson<TraceSearchResult>(await fetch(`/api/traces?${query}`, { cache: "no-store" })));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Trace 检索失败。");
    } finally {
      setTraceSearching(false);
    }
  }

  const progress = selected?.total_rows ? Math.min(100, Math.round(selected.processed_rows / selected.total_rows * 100)) : 0;
  const waiting = monitor?.queue.find((item) => item.status === "pending")?.rows ?? 0;
  const failedUnits = monitor?.queue.find((item) => item.status === "failed")?.units ?? 0;
  const validateP99 = Number(monitor?.latency?.validate_p99 ?? 0);
  const errorPages = Math.max(1, Math.ceil(errorTotal / ERROR_PAGE_SIZE));
  const latencyStages = [
    { key: "parse", label: "解析" },
    { key: "rule", label: "规则" },
    { key: "validate", label: "校验" },
    { key: "insert", label: "写入" }
  ];

  return (
    <main className="async-import-page">
      <header className="async-page-header">
        <div>
          <Link href="/" className="async-back"><ArrowLeft size={14} />返回同步预览</Link>
          <h1>异步导入与可观测性</h1>
          <p>上传即返回，复用 V2 规则引擎；处理单元、错误和 Trace 全链路可追踪。</p>
        </div>
        <div className="async-health"><span /><b>Worker 链路</b><small>2 秒刷新</small></div>
      </header>

      <nav className="async-view-tabs" role="tablist" aria-label="异步导入视图">
        <button id="work-tab" role="tab" aria-selected={activeTab === "work"} aria-controls="work-panel" className={activeTab === "work" ? "active" : ""} onClick={() => setActiveTab("work")}>
          <FileSpreadsheet size={15} />导入作业
        </button>
        <button id="monitor-tab" role="tab" aria-selected={activeTab === "monitor"} aria-controls="monitor-panel" className={activeTab === "monitor" ? "active" : ""} onClick={() => setActiveTab("monitor")}>
          <Activity size={15} />监控指标
        </button>
      </nav>

      {activeTab === "monitor" ? (
        <div id="monitor-panel" className="async-tab-panel" role="tabpanel" aria-labelledby="monitor-tab">
          {monitorDown && <div className="async-notice error"><AlertTriangle size={14} /> 监控数据源不可用（红色告警）：队列/数据库连接异常，请检查 Worker 与数据库状态。</div>}
          {!monitorDown && failedUnits > 0 && <div className="async-notice error"><AlertTriangle size={14} /> 告警：当前有 {failedUnits} 个失败处理单元，请进入任务详情查看失败节点并重试。</div>}
          {!monitorDown && waiting > 5_000 && <div className="async-notice warning"><AlertTriangle size={14} /> 告警：队列积压 {waiting.toLocaleString()} 行，已超过 5,000 行阈值。</div>}
          {!monitorDown && validateP99 > 3_000 && <div className="async-notice warning"><Clock3 size={14} /> 告警：校验 P99 为 {validateP99}ms，已超过 3,000ms 阈值。</div>}

      <section className="async-metrics">
        <Metric icon={<Activity size={16} />} label="实时吞吐" value={(monitor?.throughput_per_minute ?? 0).toLocaleString()} unit="行/分钟" />
        <Metric icon={<Database size={16} />} label="队列积压" value={waiting.toLocaleString()} unit="行" warning={waiting > 5_000} />
        <Metric icon={<Gauge size={16} />} label="校验 P95" value={String(monitor?.latency?.validate_p95 ?? 0)} unit="ms" />
        <Metric icon={<AlertTriangle size={16} />} label="错误类型" value={String(monitor?.errors.length ?? 0)} unit="类" warning={Boolean(monitor?.errors.length)} />
      </section>

      <section className="async-data-block">
        <div className="async-section-head"><div><b>吞吐趋势（近 5 分钟）</b><span>按分钟聚合成功入库行数</span></div><Activity size={15} /></div>
        <ThroughputChart series={monitor?.throughput_series ?? []} />
      </section>

      <section className="async-detail-grid">
        <div className="async-data-block">
          <div className="async-section-head"><div><b>阶段耗时分布（近 1 小时）</b><span>P50 / P95 / P99，定位瓶颈阶段</span></div><Gauge size={15} /></div>
          <div className="async-table-wrap"><table><thead><tr><th>阶段</th><th>P50</th><th>P95</th><th>P99</th></tr></thead><tbody>
            {latencyStages.map((stage) => (
              <tr key={stage.key}>
                <td>{stage.label}</td>
                <td>{monitor?.latency?.[`${stage.key}_p50`] ?? "-"}ms</td>
                <td>{monitor?.latency?.[`${stage.key}_p95`] ?? "-"}ms</td>
                <td>{monitor?.latency?.[`${stage.key}_p99`] ?? "-"}ms</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
        <div className="async-data-block">
          <div className="async-section-head"><div><b>慢批次 TOP 10（近 24 小时）</b><span>按处理单元总耗时倒序</span></div><Clock3 size={15} /></div>
          <div className="async-table-wrap"><table><thead><tr><th>文件</th><th>批次</th><th>校验</th><th>写入</th><th>总耗时</th></tr></thead><tbody>
            {(monitor?.slow_batches ?? []).map((batch) => (
              <tr key={`${batch.task_id}_${batch.unit_id}`}>
                <td>{batch.file_name ?? batch.task_id.slice(0, 14)}</td>
                <td>{batch.unit_id}</td>
                <td>{batch.validate_duration_ms}ms</td>
                <td>{batch.insert_duration_ms}ms</td>
                <td>{batch.total_duration_ms}ms</td>
              </tr>
            ))}
            {!monitor?.slow_batches?.length && <tr><td colSpan={5}>近 24 小时暂无批次性能数据</td></tr>}
          </tbody></table></div>
        </div>
      </section>

          <section className="async-data-block">
            <div className="async-section-head"><div><b>错误类型分布（近 1 小时）</b><span>点击错误码跳转到明细筛选</span></div><AlertTriangle size={15} /></div>
            <div className="async-error-dist">
              {(monitor?.errors ?? []).map((item) => (
                <button key={item.error_code} title={`筛选 ${item.error_code} 错误明细`} onClick={() => { setErrorCode(item.error_code); setErrorPage(1); setActiveTab("work"); }}>
                  <code>{item.error_code}</code><b>{item.count.toLocaleString()}</b>
                </button>
              ))}
              {!monitor?.errors?.length && <span className="async-empty compact">近 1 小时暂无错误</span>}
            </div>
          </section>
        </div>
      ) : (
        <div id="work-panel" className="async-tab-panel" role="tabpanel" aria-labelledby="work-tab">

      <section className="async-data-block">
        <div className="async-section-head"><div><b>Trace 检索</b><span>按 trace_id / 文件名 / 错误码 / 行号范围定位失败节点</span></div><Search size={15} /></div>
        <div className="async-trace-search">
          <input placeholder="task_id" value={traceQuery.task_id} onChange={(event) => setTraceQuery((q) => ({ ...q, task_id: event.target.value }))} />
          <input placeholder="trace_id" value={traceQuery.trace_id} onChange={(event) => setTraceQuery((q) => ({ ...q, trace_id: event.target.value }))} />
          <input placeholder="文件名（模糊）" value={traceQuery.file_name} onChange={(event) => setTraceQuery((q) => ({ ...q, file_name: event.target.value }))} />
          <input placeholder="批次号" inputMode="numeric" value={traceQuery.batch} onChange={(event) => setTraceQuery((q) => ({ ...q, batch: event.target.value }))} />
          <input placeholder="错误码，如 E001" value={traceQuery.error_code} onChange={(event) => setTraceQuery((q) => ({ ...q, error_code: event.target.value }))} />
          <input placeholder="行号从" inputMode="numeric" value={traceQuery.row_from} onChange={(event) => setTraceQuery((q) => ({ ...q, row_from: event.target.value }))} />
          <input placeholder="行号到" inputMode="numeric" value={traceQuery.row_to} onChange={(event) => setTraceQuery((q) => ({ ...q, row_to: event.target.value }))} />
          <button className="primary" disabled={traceSearching} onClick={() => void runTraceSearch()}>{traceSearching ? <Loader2 size={13} className="spin" /> : <Search size={13} />}检索</button>
        </div>
        {traceResult && (
          <div className="async-trace-result">
            {traceResult.tasks.map((task) => (
              <button key={task.task_id} className="async-task-row" onClick={() => { setSelectedId(task.task_id); setErrorPage(1); }}>
                <FileSpreadsheet size={15} />
                <span><b>{task.file_name}</b><small>{task.task_id} · {task.trace_id}</small></span>
                <em className={`async-status ${task.status}`}>{statusText[task.status]}</em>
              </button>
            ))}
            {!!traceResult.events.length && (
              <div className="async-timeline async-search-events">
                {traceResult.events.map((event, index) => <div key={`${event.occurred_at}_${index}`}><i className={event.event_status} /><time>{new Date(event.occurred_at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span><b>{event.event_name}</b><small>{event.unit_id ? `${event.unit_id} · ` : ""}{event.message}</small></span></div>)}
              </div>
            )}
            {!!traceResult.errors.length && (
              <div className="async-table-wrap"><table><thead><tr><th>任务</th><th>批次</th><th>行号</th><th>字段</th><th>原始值</th><th>错误码</th><th>原因</th><th>建议</th></tr></thead><tbody>
                {traceResult.errors.map((error, index) => (
                  <tr key={`${error.task_id}_${error.id ?? index}`}>
                    <td>{error.task_id.slice(0, 14)}…</td><td>{error.unit_id}</td><td>{error.row_number}</td><td>{error.field_name}</td>
                    <td>{error.raw_value || "-"}</td><td><code>{error.error_code}</code></td><td>{error.error_reason}</td><td>{errorAdvice(error.error_code)}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
            {!traceResult.tasks.length && !traceResult.errors.length && <div className="async-empty compact">没有匹配的 Trace 或错误记录</div>}
          </div>
        )}
      </section>

      <section className="async-upload-band">
        <label className="async-file-picker">
          <UploadCloud size={18} />
          <span>{file?.name || "选择 Excel、Word 或 PDF 文件"}</span>
          <input type="file" accept=".xlsx,.xls,.docx,.pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <label className="async-rule-select"><span>解析规则</span><select value={ruleId} onChange={(event) => setRuleId(event.target.value)}><option value="">请选择规则</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label>
        <button className="primary async-create" disabled={!file || !ruleId || busy} onClick={() => void createTask()}>{busy ? <Loader2 size={15} className="spin" /> : <UploadCloud size={15} />}创建异步任务</button>
      </section>
      {(notice || loadError) && <div className={`async-notice ${loadError ? "error" : ""}`}>{loadError || notice}</div>}

      <div className="async-workspace">
        <section className="async-task-list">
          <div className="async-section-head"><div><b>导入任务</b><span>最近 {tasks.length} 个任务</span></div><button title="刷新" onClick={() => void loadTasks()}><RefreshCw size={14} /></button></div>
          {tasks.length === 0 ? <div className="async-empty">暂无异步任务</div> : tasks.map((task) => (
            <button key={task.task_id} className={`async-task-row ${selected?.task_id === task.task_id ? "active" : ""}`} onClick={() => { setSelectedId(task.task_id); setErrorPage(1); }}>
              <FileSpreadsheet size={17} />
              <span><b>{task.file_name}</b><small>{task.task_id.slice(0, 18)}…</small></span>
              <em className={`async-status ${task.status}`}>{statusText[task.status]}</em>
            </button>
          ))}
        </section>

        <section className="async-detail">
          {!selected ? <div className="async-empty">选择任务查看处理详情</div> : <>
            <div className="async-detail-head"><div><span className={`async-status ${selected.status}`}>{statusText[selected.status]}</span><h2>{selected.file_name}</h2><p>{selected.task_id} · {selected.trace_id}</p></div><div className="async-detail-actions"><strong>{progress}%</strong><button onClick={() => void retryFailed()} disabled={selected.failed_rows === 0}><RefreshCw size={13} />重试失败批次</button><Link href={`/api/import-tasks/${selected.task_id}/errors/export`}><FileSpreadsheet size={13} />导出错误</Link></div></div>
            {selected.degraded && <div className="async-degraded"><AlertTriangle size={15} />SKU 校验已降级：本次导入未经过商品主数据完整校验，需要后续复核。</div>}
            <div className="async-progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="async-counts"><Count label="总行数" value={selected.total_rows} /><Count label="已处理" value={selected.processed_rows} /><Count label="成功" value={selected.success_rows} ok /><Count label="失败" value={selected.failed_rows} warn /><Count label="完成批次" value={`${selected.completed_batches}/${selected.total_batches}`} /></div>

            <div className="async-detail-grid">
              <div className="async-data-block"><div className="async-section-head"><div><b>批次性能</b><span>每个处理单元独立重试、独立计时</span></div><Clock3 size={15} /></div><div className="async-table-wrap"><table><thead><tr><th>批次</th><th>范围</th><th>状态</th><th>校验</th><th>写入</th><th>总耗时</th><th>重试</th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.unit_id}><td>{batch.unit_id}</td><td>{batch.start_row}-{batch.end_row}</td><td>{batch.status}</td><td>{batch.validate_duration_ms ?? "-"}ms</td><td>{batch.insert_duration_ms ?? "-"}ms</td><td>{batch.total_duration_ms ?? "-"}ms</td><td>{batch.retry_count}</td></tr>)}</tbody></table></div></div>
              <div className="async-data-block"><div className="async-section-head"><div><b>Trace 时间线</b><span>API → Outbox → Queue → Worker → DB</span></div><Network size={15} /></div><div className="async-timeline">{trace.map((event, index) => <div key={`${event.occurred_at}_${index}`}><i className={event.event_status} /><time>{new Date(event.occurred_at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span><b>{event.event_name}</b><small>{event.unit_id ? `${event.unit_id} · ` : ""}{event.message}</small></span></div>)}</div></div>
            </div>

            <div className="async-data-block async-errors">
              <div className="async-section-head">
                <div><b>行级错误</b><span>原始值已按字段类型脱敏，共 {errorTotal.toLocaleString()} 条</span></div>
                <div className="async-error-filters">
                  <label><Search size={13} /><select value={errorCode} onChange={(event) => { setErrorCode(event.target.value); setErrorPage(1); }}><option value="">全部错误</option><option value="E001">E001 SKU 不存在</option><option value="E002">E002 必填缺失</option><option value="E003">E003 电话格式</option><option value="E004">E004 数量非法</option><option value="E005">E005 外部编码重复</option><option value="W001">W001 降级未校验</option></select></label>
                  <input placeholder="批次号" inputMode="numeric" value={errorBatch} onChange={(event) => { setErrorBatch(event.target.value); setErrorPage(1); }} />
                </div>
              </div>
              <div className="async-table-wrap"><table><thead><tr><th>批次</th><th>行号</th><th>字段</th><th>原始值</th><th>错误码</th><th>原因</th><th>建议</th></tr></thead><tbody>{errors.map((error) => <tr key={error.id}><td>{error.unit_id}</td><td>{error.row_number}</td><td>{error.field_name}</td><td>{error.raw_value || "-"}</td><td><code>{error.error_code}</code></td><td>{error.error_reason}</td><td>{errorAdvice(error.error_code)}</td></tr>)}</tbody></table>{!errors.length && <div className="async-empty compact">当前筛选下没有错误</div>}</div>
              <div className="async-pagination">
                <button disabled={errorPage <= 1} onClick={() => setErrorPage((page) => Math.max(1, page - 1))}><ChevronLeft size={13} />上一页</button>
                <span>第 {errorPage} / {errorPages} 页</span>
                <button disabled={errorPage >= errorPages} onClick={() => setErrorPage((page) => Math.min(errorPages, page + 1))}>下一页<ChevronRight size={13} /></button>
              </div>
            </div>
          </>}
        </section>
      </div>
        </div>
      )}
    </main>
  );
}

function ThroughputChart({ series }: { series: Array<{ minute: string; rows: number }> }) {
  if (!series.length) return <div className="async-empty compact">近 5 分钟暂无入库数据</div>;
  const width = 560;
  const height = 104;
  const max = Math.max(...series.map((point) => point.rows), 1);
  const step = series.length > 1 ? (width - 8) / (series.length - 1) : 0;
  const points = series.map((point, index) => `${Math.round(4 + index * step)},${Math.round(8 + (1 - point.rows / max) * (height - 20))}`);
  return (
    <div className="async-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="近 5 分钟吞吐趋势">
        <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="async-chart-axis">{series.map((point) => <span key={point.minute}>{point.minute.slice(11)}</span>)}</div>
      <div className="async-chart-legend">{series.map((point) => <span key={point.minute}>{point.minute.slice(11)}：{point.rows.toLocaleString()} 行</span>)}</div>
    </div>
  );
}

function Metric({ icon, label, value, unit, warning }: { icon: React.ReactNode; label: string; value: string; unit: string; warning?: boolean }) {
  return <div className={`async-metric ${warning ? "warning" : ""}`}><span>{icon}</span><div><small>{label}</small><b>{value} <em>{unit}</em></b></div></div>;
}

function Count({ label, value, ok, warn }: { label: string; value: string | number; ok?: boolean; warn?: boolean }) {
  return <div><span>{label}</span><b className={ok ? "ok" : warn ? "warn" : ""}>{typeof value === "number" ? value.toLocaleString() : value}</b></div>;
}
