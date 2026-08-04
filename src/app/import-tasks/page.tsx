"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
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
  unit_id?: string;
  message: string;
  occurred_at: string;
};
type Monitor = {
  throughput_per_minute: number;
  queue: Array<{ status: string; units: number; rows: number }>;
  latency: Record<string, number | null>;
  errors: Array<{ error_code: string; count: number }>;
};

const statusText: Record<TaskStatus, string> = {
  pending: "等待处理",
  processing: "处理中",
  completed: "已完成",
  partial_success: "部分成功",
  failed: "失败"
};

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
  const [batches, setBatches] = useState<Batch[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [errorCode, setErrorCode] = useState("");
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

  const loadDetail = useCallback(async (task: Task) => {
    const [errorResult, batchResult, traceResult] = await Promise.allSettled([
      readJson<{ items: ImportError[] }>(await fetch(`/api/import-tasks/${task.task_id}/errors?error_code=${encodeURIComponent(errorCode)}&page_size=50`, { cache: "no-store" })),
      readJson<{ items: Batch[] }>(await fetch(`/api/import-tasks/${task.task_id}/batches`, { cache: "no-store" })),
      readJson<{ events: TraceEvent[] }>(await fetch(`/api/traces/${task.trace_id}`, { cache: "no-store" }))
    ]);
    if (errorResult.status === "fulfilled") setErrors(errorResult.value.items);
    if (batchResult.status === "fulfilled") setBatches(batchResult.value.items);
    if (traceResult.status === "fulfilled") setTrace(traceResult.value.events);
  }, [errorCode]);

  const loadMonitor = useCallback(async () => {
    try {
      setMonitor(await readJson<Monitor>(await fetch("/api/import-monitor/summary", { cache: "no-store" })));
    } catch {
      setMonitor(null);
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
    if (selected) void loadDetail(selected);
  }, [loadDetail, selected]);

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
      const task = await readJson<Task & { upload_duration_ms: number }>(await fetch("/api/import-tasks", { method: "POST", body: form }));
      setSelectedId(task.task_id);
      setNotice(`任务已创建，上传接口 ${task.upload_duration_ms}ms 返回。`);
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

  const progress = selected?.total_rows ? Math.min(100, Math.round(selected.processed_rows / selected.total_rows * 100)) : 0;
  const waiting = monitor?.queue.find((item) => item.status === "pending")?.rows ?? 0;

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

      <section className="async-metrics">
        <Metric icon={<Activity size={16} />} label="实时吞吐" value={(monitor?.throughput_per_minute ?? 0).toLocaleString()} unit="行/分钟" />
        <Metric icon={<Database size={16} />} label="队列积压" value={waiting.toLocaleString()} unit="行" warning={waiting > 5_000} />
        <Metric icon={<Gauge size={16} />} label="校验 P95" value={String(monitor?.latency?.validate_p95 ?? 0)} unit="ms" />
        <Metric icon={<AlertTriangle size={16} />} label="错误类型" value={String(monitor?.errors.length ?? 0)} unit="类" warning={Boolean(monitor?.errors.length)} />
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
            <button key={task.task_id} className={`async-task-row ${selected?.task_id === task.task_id ? "active" : ""}`} onClick={() => setSelectedId(task.task_id)}>
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

            <div className="async-data-block async-errors"><div className="async-section-head"><div><b>行级错误</b><span>原始值已按字段类型脱敏</span></div><label><Search size={13} /><select value={errorCode} onChange={(event) => setErrorCode(event.target.value)}><option value="">全部错误</option><option value="E001">E001 SKU 不存在</option><option value="E002">E002 必填缺失</option><option value="E003">E003 电话格式</option><option value="E004">E004 数量非法</option><option value="E005">E005 外部编码重复</option><option value="W001">W001 降级未校验</option></select></label></div><div className="async-table-wrap"><table><thead><tr><th>批次</th><th>行号</th><th>字段</th><th>原始值</th><th>错误码</th><th>原因</th></tr></thead><tbody>{errors.map((error) => <tr key={error.id}><td>{error.unit_id}</td><td>{error.row_number}</td><td>{error.field_name}</td><td>{error.raw_value || "-"}</td><td><code>{error.error_code}</code></td><td>{error.error_reason}</td></tr>)}</tbody></table>{!errors.length && <div className="async-empty compact">当前筛选下没有错误</div>}</div></div>
          </>}
        </section>
      </div>
    </main>
  );
}

function Metric({ icon, label, value, unit, warning }: { icon: React.ReactNode; label: string; value: string; unit: string; warning?: boolean }) {
  return <div className={`async-metric ${warning ? "warning" : ""}`}><span>{icon}</span><div><small>{label}</small><b>{value} <em>{unit}</em></b></div></div>;
}

function Count({ label, value, ok, warn }: { label: string; value: string | number; ok?: boolean; warn?: boolean }) {
  return <div><span>{label}</span><b className={ok ? "ok" : warn ? "warn" : ""}>{typeof value === "number" ? value.toLocaleString() : value}</b></div>;
}
