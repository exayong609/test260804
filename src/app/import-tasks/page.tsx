"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
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

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("zh-CN", { hour12: false });
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
  const [traceQuery, setTraceQuery] = useState({ trace_id: "", file_name: "", error_code: "", row_from: "", row_to: "" });
  const [traceResult, setTraceResult] = useState<TraceSearchResult | null>(null);
  const [traceSearching, setTraceSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<"ops" | "monitor">("ops");
  const clock = useClock();

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

  async function createTask() {
    if (!file || !ruleId) return;
    setBusy(true);
    setNotice("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("ruleId", ruleId);
      const task = await readJson<Task & { upload_duration_ms?: number; duplicated?: boolean; notice?: string }>(await fetch("/api/import-tasks", { method: "POST", body: form }));
      setSelectedId(task.task_id);
      setErrorPage(1);
      setNotice(task.duplicated ? (task.notice ?? "相同文件已导入，已定位到已有任务。") : `任务已创建，上传接口 ${task.upload_duration_ms ?? 0}ms 返回。`);
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
  const waitingUnits = monitor?.queue.find((item) => item.status === "pending")?.rows ?? 0;
  const activeUnits = monitor?.queue.find((item) => item.status === "processing")?.units ?? 0;
  const failedUnits = monitor?.queue.find((item) => item.status === "failed")?.units ?? 0;
  const errorPages = Math.max(1, Math.ceil(errorTotal / ERROR_PAGE_SIZE));
  const latencyStages = [
    { key: "parse", label: "解析" },
    { key: "rule", label: "规则" },
    { key: "validate", label: "校验" },
    { key: "insert", label: "写入" }
  ];
  const latencyMax = Math.max(1, ...latencyStages.map((stage) => monitor?.latency?.[`${stage.key}_p99`] ?? 0));

  return (
    <main className="ops-console">
      <header className="oc-topbar">
        <div className="oc-brand">
          <span className="oc-brand-mark"><Activity size={15} /></span>
          <div>
            <h1>IMPORT PULSE</h1>
            <p>异步导入 · 全链路可观测性控制台</p>
          </div>
        </div>
        <div className="oc-topbar-right">
          <Link href="/" className="oc-back"><ArrowLeft size={13} />同步预览</Link>
          <span className={`oc-live ${monitorDown ? "down" : ""}`}><i />{monitorDown ? "LINK DOWN" : "LIVE"}</span>
          <time className="oc-clock">{clock}</time>
        </div>
      </header>

      {monitorDown && <div className="oc-alert"><AlertTriangle size={14} /><b>红色告警</b>监控数据源不可用：队列或数据库连接异常，请立即检查 Worker 与数据库状态。</div>}

      <nav className="oc-tabs">
        <button className={`oc-tab ${tab === "ops" ? "active" : ""}`} onClick={() => setTab("ops")}><UploadCloud size={13} />导入操作</button>
        <button className={`oc-tab ${tab === "monitor" ? "active" : ""}`} onClick={() => setTab("monitor")}><Activity size={13} />监控大盘</button>
      </nav>

      {tab === "monitor" && (<>
      <section className="oc-kpis">
        <div className="oc-kpi">
          <small><Activity size={12} />实时吞吐</small>
          <b>{(monitor?.throughput_per_minute ?? 0).toLocaleString()}</b>
          <em>行 / 分钟</em>
        </div>
        <div className={`oc-kpi ${waitingUnits > 5_000 ? "warn" : ""}`}>
          <small><Database size={12} />队列积压</small>
          <b>{waitingUnits.toLocaleString()}</b>
          <em>行待处理{waitingUnits > 5_000 ? " · 超阈值" : ""}</em>
        </div>
        <div className="oc-kpi">
          <small><Gauge size={12} />校验 P95</small>
          <b>{(monitor?.latency?.validate_p95 ?? 0).toLocaleString()}</b>
          <em>毫秒</em>
        </div>
        <div className={`oc-kpi oc-clickable ${failedUnits ? "bad" : ""}`} title="点击查看导入任务" onClick={() => setTab("ops")}>
          <small><AlertTriangle size={12} />失败批次</small>
          <b>{failedUnits.toLocaleString()}</b>
          <em>个处理单元 · 点击下钻</em>
        </div>
      </section>

      <section className="oc-grid-main">
        <div className="oc-panel oc-chart-panel">
          <div className="oc-panel-head"><b>吞吐趋势</b><span>近 5 分钟 · 按分钟聚合成功入库行数</span><Activity size={14} className="oc-panel-icon" /></div>
          <ThroughputChart series={monitor?.throughput_series ?? []} />
        </div>
        <div className="oc-panel">
          <div className="oc-panel-head"><b>队列状态</b><span>处理单元按状态分布</span><Database size={14} className="oc-panel-icon" /></div>
          <div className="oc-queue">
            {(monitor?.queue ?? []).map((item) => (
              <div key={item.status} className={`oc-queue-row ${item.status} ${item.status === "failed" && item.units > 0 ? "oc-clickable" : ""}`} title={item.status === "failed" && item.units > 0 ? "点击查看导入任务" : undefined} onClick={item.status === "failed" && item.units > 0 ? () => setTab("ops") : undefined}>
                <span className="oc-queue-dot" />
                <span className="oc-queue-name">{item.status}</span>
                <b>{item.units.toLocaleString()}</b>
                <em>{item.rows.toLocaleString()} 行</em>
              </div>
            ))}
            {!monitor?.queue?.length && <div className="oc-empty">暂无队列数据</div>}
            <div className="oc-queue-meta">处理中 {activeUnits} 单元 · 积压 {waitingUnits.toLocaleString()} 行 · 阈值 5,000 行</div>
          </div>
        </div>
        <div className="oc-panel">
          <div className="oc-panel-head"><b>阶段耗时</b><span>近 1 小时 P50 / P95 / P99</span><Gauge size={14} className="oc-panel-icon" /></div>
          <div className="oc-latency">
            {latencyStages.map((stage) => {
              const p50 = monitor?.latency?.[`${stage.key}_p50`] ?? 0;
              const p95 = monitor?.latency?.[`${stage.key}_p95`] ?? 0;
              const p99 = monitor?.latency?.[`${stage.key}_p99`] ?? 0;
              const empty = !p50 && !p95 && !p99;
              return (
                <div key={stage.key} className="oc-latency-row">
                  <span className="oc-latency-name">{stage.label}</span>
                  <div className="oc-latency-bars">
                    {!empty && <>
                      <i className="p50" style={{ width: `${Math.max(2, p50 / latencyMax * 100)}%` }} />
                      <i className="p95" style={{ width: `${Math.max(2, p95 / latencyMax * 100)}%` }} />
                      <i className="p99" style={{ width: `${Math.max(2, p99 / latencyMax * 100)}%` }} />
                    </>}
                  </div>
                  <span className="oc-latency-nums">{empty ? <><b>—</b><em>暂无数据</em></> : <><b>{p95}</b><em>P95 ms</em></>}</span>
                </div>
              );
            })}
            <div className="oc-latency-legend"><span><i className="p50" />P50</span><span><i className="p95" />P95</span><span><i className="p99" />P99</span></div>
          </div>
        </div>
      </section>

      <section className="oc-grid-2">
        <div className="oc-panel">
          <div className="oc-panel-head"><b>慢批次 TOP 10</b><span>近 24 小时 · 按总耗时倒序</span><Clock3 size={14} className="oc-panel-icon" /></div>
          <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>文件</th><th>批次</th><th>校验</th><th>写入</th><th>总耗时</th></tr></thead><tbody>
            {(monitor?.slow_batches ?? []).map((batch) => (
              <tr key={`${batch.task_id}_${batch.unit_id}`} className="oc-row-link" title={`定位任务 ${batch.task_id}`} onClick={() => { setSelectedId(batch.task_id); setErrorPage(1); setTab("ops"); }}>
                <td title={batch.file_name ?? batch.task_id}>{(batch.file_name ?? batch.task_id).slice(0, 22)}</td>
                <td><code>{batch.unit_id}</code></td>
                <td>{batch.validate_duration_ms}ms</td>
                <td>{batch.insert_duration_ms}ms</td>
                <td><b>{batch.total_duration_ms}ms</b><span className="oc-row-hint">→</span></td>
              </tr>
            ))}
            {!monitor?.slow_batches?.length && <tr><td colSpan={5} className="oc-empty-cell">近 24 小时暂无批次性能数据</td></tr>}
          </tbody></table></div>
        </div>
        <div className="oc-panel">
          <div className="oc-panel-head"><b>错误类型分布</b><span>近 1 小时 · 点击跳转错误明细</span><AlertTriangle size={14} className="oc-panel-icon" /></div>
          <div className="oc-errdist">
            {(monitor?.errors ?? []).map((item) => {
              const maxCount = Math.max(...(monitor?.errors ?? [{ count: 1 }]).map((entry) => entry.count), 1);
              return (
                <button key={item.error_code} className="oc-errdist-row" title={`筛选 ${item.error_code} 错误明细`} onClick={() => { setErrorCode(item.error_code); setErrorPage(1); setTab("ops"); }}>
                  <code>{item.error_code}</code>
                  <span className="oc-errdist-bar"><i style={{ width: `${Math.max(3, item.count / maxCount * 100)}%` }} /></span>
                  <b>{item.count.toLocaleString()}</b>
                </button>
              );
            })}
            {!monitor?.errors?.length && <div className="oc-empty">近 1 小时暂无错误</div>}
          </div>
        </div>
      </section>
      </>)}

      {tab === "ops" && (<>
      <section className="oc-upload">
        <label className="oc-file-picker">
          <UploadCloud size={16} />
          <span>{file?.name || "选择 Excel、Word 或 PDF 文件"}</span>
          <input type="file" accept=".xlsx,.xls,.docx,.pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <label className="oc-rule-select"><span>解析规则</span><select value={ruleId} onChange={(event) => setRuleId(event.target.value)}><option value="">请选择规则</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label>
        <button className="oc-btn primary" disabled={!file || !ruleId || busy} onClick={() => void createTask()}>{busy ? <Loader2 size={14} className="spin" /> : <UploadCloud size={14} />}创建异步任务</button>
      </section>
      {(notice || loadError) && <div className={`oc-notice ${loadError ? "error" : ""}`}>{loadError || notice}</div>}

      <section className="oc-panel">
        <div className="oc-panel-head"><b>Trace 检索</b><span>按 trace_id / 文件名 / 错误码 / 行号范围定位失败节点，点击结果定位到下方任务</span><Search size={14} className="oc-panel-icon" /></div>
        <div className="oc-trace-search">
          <input placeholder="trace_id" value={traceQuery.trace_id} onChange={(event) => setTraceQuery((q) => ({ ...q, trace_id: event.target.value }))} />
          <input placeholder="文件名（模糊）" value={traceQuery.file_name} onChange={(event) => setTraceQuery((q) => ({ ...q, file_name: event.target.value }))} />
          <input placeholder="错误码 E001" value={traceQuery.error_code} onChange={(event) => setTraceQuery((q) => ({ ...q, error_code: event.target.value }))} />
          <input placeholder="行号从" inputMode="numeric" value={traceQuery.row_from} onChange={(event) => setTraceQuery((q) => ({ ...q, row_from: event.target.value }))} />
          <input placeholder="行号到" inputMode="numeric" value={traceQuery.row_to} onChange={(event) => setTraceQuery((q) => ({ ...q, row_to: event.target.value }))} />
          <button className="oc-btn" disabled={traceSearching} onClick={() => void runTraceSearch()}>{traceSearching ? <Loader2 size={13} className="spin" /> : <Search size={13} />}检索</button>
        </div>
        {traceResult && (
          <div className="oc-trace-result">
            {traceResult.tasks.map((task) => (
              <button key={task.task_id} className="oc-task-row" onClick={() => { setSelectedId(task.task_id); setErrorPage(1); }}>
                <FileSpreadsheet size={14} />
                <span><b>{task.file_name}</b><small>{task.task_id} · {task.trace_id}</small></span>
                <em className={`oc-status ${task.status}`}>{statusText[task.status]}</em>
              </button>
            ))}
            {!!traceResult.errors.length && (
              <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>任务</th><th>批次</th><th>行号</th><th>字段</th><th>原始值</th><th>错误码</th><th>原因</th><th>建议</th></tr></thead><tbody>
                {traceResult.errors.map((error, index) => (
                  <tr key={`${error.task_id}_${error.id ?? index}`}>
                    <td title={error.task_id}>{error.task_id.slice(5, 13)}…</td><td><code>{error.unit_id}</code></td><td>{error.row_number}</td><td>{error.field_name}</td>
                    <td>{error.raw_value || "-"}</td><td><code className="oc-code-bad">{error.error_code}</code></td><td>{error.error_reason}</td><td className="oc-advice">{errorAdvice(error.error_code)}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
            {!traceResult.tasks.length && !traceResult.errors.length && <div className="oc-empty">没有匹配的 Trace 或错误记录</div>}
          </div>
        )}
      </section>

      <div className="oc-work">
        <section className="oc-panel oc-task-list">
          <div className="oc-panel-head"><div><b>导入任务</b><span>最近 {tasks.length} 个</span></div><button title="刷新" className="oc-icon-btn" onClick={() => void loadTasks()}><RefreshCw size={13} /></button></div>
          <div className="oc-task-rows">
            {tasks.length === 0 ? <div className="oc-empty">暂无异步任务</div> : tasks.map((task) => (
              <button key={task.task_id} title={`${task.file_name} · ${task.task_id}`} className={`oc-task-row ${selected?.task_id === task.task_id ? "active" : ""}`} onClick={() => { setSelectedId(task.task_id); setErrorPage(1); }}>
                <FileSpreadsheet size={15} />
                <span><b>{task.file_name}</b><small>#{task.task_id.slice(5, 12)} · {new Date(task.created_at).toLocaleTimeString("zh-CN", { hour12: false })} · {task.total_rows.toLocaleString()} 行{task.failed_rows > 0 ? ` · 失败 ${task.failed_rows.toLocaleString()}` : ""}</small></span>
                <em className={`oc-status ${task.status}`}>{statusText[task.status]}</em>
              </button>
            ))}
          </div>
        </section>

        <section className="oc-panel oc-detail">
          {!selected ? <div className="oc-empty">选择任务查看处理详情</div> : <>
            <div className="oc-detail-head">
              <div>
                <span className={`oc-status ${selected.status}`}>{statusText[selected.status]}</span>
                <h2>{selected.file_name}</h2>
                <p><code>{selected.task_id}</code> · <code>{selected.trace_id}</code></p>
              </div>
              <div className="oc-detail-actions">
                <strong>{progress}<em>%</em></strong>
                <button className="oc-btn" onClick={() => void retryFailed()} disabled={selected.failed_rows === 0}><RefreshCw size={12} />重试失败批次</button>
                <Link className="oc-btn" href={`/api/import-tasks/${selected.task_id}/errors/export`}><FileSpreadsheet size={12} />导出错误</Link>
              </div>
            </div>
            {selected.degraded && <div className="oc-degraded"><AlertTriangle size={14} />SKU 校验已降级：本次导入未经过商品主数据完整校验，需要后续复核。</div>}
            <div className="oc-progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="oc-counts">
              <Count label="总行数" value={selected.total_rows} />
              <Count label="已处理" value={selected.processed_rows} />
              <Count label="成功" value={selected.success_rows} ok />
              <Count label="失败" value={selected.failed_rows} warn />
              <Count label="完成批次" value={`${selected.completed_batches}/${selected.total_batches}`} />
            </div>

            <div className="oc-detail-grid">
              <div className="oc-subpanel">
                <div className="oc-subpanel-head"><div><b>批次性能</b><span>独立重试、独立计时</span></div><Clock3 size={13} /></div>
                <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>批次</th><th>范围</th><th>状态</th><th>校验</th><th>写入</th><th>总耗时</th><th>重试</th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.unit_id}><td><code>{batch.unit_id}</code></td><td>{batch.start_row}-{batch.end_row}</td><td>{batch.status}</td><td>{batch.validate_duration_ms ?? "-"}ms</td><td>{batch.insert_duration_ms ?? "-"}ms</td><td><b>{batch.total_duration_ms ?? "-"}ms</b></td><td>{batch.retry_count}</td></tr>)}</tbody></table></div>
              </div>
              <div className="oc-subpanel">
                <div className="oc-subpanel-head"><div><b>Trace 时间线</b><span>API → Outbox → Queue → Worker → DB</span></div><Network size={13} /></div>
                <div className="oc-timeline">{trace.map((event, index) => <div key={`${event.occurred_at}_${index}`} className={event.event_status}><i /><time>{new Date(event.occurred_at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span><b>{event.event_name}</b><small>{event.unit_id ? `${event.unit_id} · ` : ""}{event.message}</small></span></div>)}</div>
              </div>
            </div>

            <div className="oc-subpanel oc-errors">
              <div className="oc-subpanel-head">
                <div><b>行级错误</b><span>原始值已脱敏 · 共 {errorTotal.toLocaleString()} 条</span></div>
                <div className="oc-error-filters">
                  <select value={errorCode} onChange={(event) => { setErrorCode(event.target.value); setErrorPage(1); }}><option value="">全部错误</option><option value="E001">E001 SKU 不存在</option><option value="E002">E002 必填缺失</option><option value="E003">E003 电话格式</option><option value="E004">E004 数量非法</option><option value="E005">E005 外部编码重复</option><option value="W001">W001 降级未校验</option></select>
                  <input placeholder="批次号" inputMode="numeric" value={errorBatch} onChange={(event) => { setErrorBatch(event.target.value); setErrorPage(1); }} />
                </div>
              </div>
              <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>批次</th><th>行号</th><th>字段</th><th>原始值</th><th>错误码</th><th>原因</th><th>建议</th></tr></thead><tbody>{errors.map((error) => <tr key={error.id}><td><code>{error.unit_id}</code></td><td>{error.row_number}</td><td>{error.field_name}</td><td>{error.raw_value || "-"}</td><td><code className="oc-code-bad">{error.error_code}</code></td><td>{error.error_reason}</td><td className="oc-advice">{errorAdvice(error.error_code)}</td></tr>)}</tbody></table>{!errors.length && <div className="oc-empty compact">当前筛选下没有错误</div>}</div>
              <div className="oc-pagination">
                <button disabled={errorPage <= 1} onClick={() => setErrorPage((page) => Math.max(1, page - 1))}><ChevronLeft size={12} />上一页</button>
                <span>{errorPage} / {errorPages}</span>
                <button disabled={errorPage >= errorPages} onClick={() => setErrorPage((page) => Math.min(errorPages, page + 1))}>下一页<ChevronRight size={12} /></button>
              </div>
            </div>
          </>}
        </section>
      </div>
      </>)}
    </main>
  );
}

function ThroughputChart({ series }: { series: Array<{ minute: string; rows: number }> }) {
  if (!series.length) return <div className="oc-empty">近 5 分钟暂无入库数据</div>;
  const width = 640;
  const height = 180;
  const padTop = 16;
  const max = Math.max(...series.map((point) => point.rows), 1);
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  const coords = series.map((point, index) => [Math.round(index * step), height - Math.round(point.rows / max * (height - padTop))] as const);
  const line = coords.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const gridLines = [0.25, 0.5, 0.75].map((ratio) => Math.round(height - ratio * (height - padTop)));
  return (
    <div className="oc-chart">
      <svg viewBox={`0 0 ${width} ${height + 22}`} role="img" aria-label="近 5 分钟吞吐趋势">
        <defs>
          <linearGradient id="ocArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {gridLines.map((y) => <line key={y} x1="0" y1={y} x2={width} y2={y} className="oc-chart-grid" />)}
        <polygon points={area} fill="url(#ocArea)" />
        <polyline points={line} fill="none" stroke="#2dd4bf" strokeWidth="2" strokeLinejoin="round" />
        {coords.map(([x, y], index) => <circle key={index} cx={x} cy={y} r="3" fill="#2dd4bf" />)}
        {coords.map(([x], index) => <text key={index} x={x} y={height + 16} textAnchor="middle">{series[index].minute.slice(11)}</text>)}
        <text x={width} y={12} textAnchor="end" className="oc-chart-max">峰值 {max.toLocaleString()} 行/分</text>
      </svg>
    </div>
  );
}

function Count({ label, value, ok, warn }: { label: string; value: string | number; ok?: boolean; warn?: boolean }) {
  return <div className="oc-count"><span>{label}</span><b className={ok ? "ok" : warn ? "warn" : ""}>{typeof value === "number" ? value.toLocaleString() : value}</b></div>;
}
