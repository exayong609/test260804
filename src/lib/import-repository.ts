import { createHash, randomUUID } from "node:crypto";
import { ensureImportSchema } from "@/lib/import-schema";
import { getSql } from "@/lib/store";
import type {
  BatchPerformanceInput,
  ImportBatchPayload,
  ImportErrorInput,
  ImportTaskCreateInput,
  ImportTaskInitInput,
  ImportTaskSnapshot,
  OutboxRecord,
  ParsedTaskLookup,
  ParsedTaskPayload
} from "@/lib/import-types";
import { toImportErrorRecord } from "@/lib/import-types";
import { fillMinuteGaps } from "@/lib/import-error-advice";
import type { OrderGroup, ParsedOrderRow } from "@/types";

const DEFAULT_BATCH_SIZE = 1_000;

function requireSql() {
  const sql = getSql();
  if (!sql) throw new Error("异步导入需要配置 DATABASE_URL。");
  return sql;
}

function batchSize() {
  const configured = Number(process.env.IMPORT_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  return Number.isFinite(configured) ? Math.max(100, Math.min(configured, 2_000)) : DEFAULT_BATCH_SIZE;
}

function redact(field: string, value: unknown) {
  const text = String(value ?? "");
  if (/phone/i.test(field) && text.length >= 7) return `${text.slice(0, 3)}****${text.slice(-4)}`;
  if (/address/i.test(field) && text.length > 6) return `${text.slice(0, 6)}***`;
  return text.slice(0, 500);
}

function mapTask(row: {
  id: string;
  trace_id: string;
  file_name: string;
  status: ImportTaskSnapshot["status"];
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  degraded: boolean;
  created_at: Date;
  completed_at: Date | null;
}): ImportTaskSnapshot {
  return {
    task_id: row.id,
    trace_id: row.trace_id,
    file_name: row.file_name,
    status: row.status,
    total_rows: row.total_rows,
    processed_rows: row.processed_rows,
    success_rows: row.success_rows,
    failed_rows: row.failed_rows,
    total_batches: row.total_batches,
    completed_batches: row.completed_batches,
    degraded: row.degraded,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString()
  };
}

export async function createImportTask(input: ImportTaskCreateInput) {
  await ensureImportSchema();
  const sql = requireSql();
  const taskId = `task_${randomUUID()}`;
  const traceId = `trace_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;
  const totalBatches = input.estimatedRows > 0 ? Math.ceil(input.estimatedRows / batchSize()) : 0;

  await sql.begin(async (tx) => {
    await tx`
      insert into import_tasks (
        id, file_name, file_hash, status, total_rows, total_batches, trace_id, rule_payload
      ) values (
        ${taskId}, ${input.fileName}, ${input.fileHash}, 'pending', ${input.estimatedRows},
        ${totalBatches}, ${traceId}, ${tx.json(input.rule)}
      )
    `;
    await tx`
      insert into import_files (task_id, mime_type, content, size_bytes)
      values (${taskId}, ${input.mimeType}, ${input.fileBytes}, ${input.fileBytes.byteLength})
    `;
    await tx`
      insert into event_outbox (id, aggregate_id, event_type, trace_id, payload)
      values (
        ${eventId}, ${taskId}, 'ImportTaskCreated', ${traceId},
        ${tx.json({ task_id: taskId, trace_id: traceId })}
      )
    `;
    await tx`
      insert into trace_events (trace_id, task_id, event_name, event_status, message, metadata)
      values (
        ${traceId}, ${taskId}, 'ImportTaskCreated', 'success',
        '上传接口已在同一事务创建任务、文件和 Outbox 事件',
        ${tx.json({ estimated_rows: input.estimatedRows, file_hash: input.fileHash })}
      )
    `;
  });

  return getImportTask(taskId);
}

export async function findTaskByFileHash(fileHash: string): Promise<ImportTaskSnapshot | null> {
  if (!fileHash) return null;
  const sql = requireSql();
  const rows = await sql<Parameters<typeof mapTask>[0][]>`
    select id, trace_id, file_name, status, total_rows, processed_rows, success_rows,
      failed_rows, total_batches, completed_batches, degraded, created_at, completed_at
    from import_tasks where file_hash = ${fileHash} order by created_at desc limit 1
  `;
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function createOrReuseImportTaskFast(input: ImportTaskInitInput) {
  const sql = requireSql();
  const taskId = `task_${randomUUID()}`;
  const traceId = `trace_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;
  const totalBatches = input.estimatedRows > 0 ? Math.ceil(input.estimatedRows / batchSize()) : 0;
  const deferredUntil = new Date(Date.now() + 10 * 60_000);

  const rows = await sql<(Parameters<typeof mapTask>[0] & { duplicated: boolean; file_persisted: boolean })[]>`
    with existing as (
      select t.id, t.trace_id, t.file_name, t.status, t.total_rows, t.processed_rows, t.success_rows,
        t.failed_rows, t.total_batches, t.completed_batches, t.degraded, t.created_at, t.completed_at,
        (f.task_id is not null) as file_persisted
      from import_tasks t
      left join import_files f on f.task_id = t.id
      where t.file_hash = ${input.fileHash}
      order by t.created_at desc
      limit 1
    ), new_task as (
      insert into import_tasks (
        id, file_name, file_hash, status, total_rows, total_batches, trace_id, rule_payload
      )
      select ${taskId}, ${input.fileName}, ${input.fileHash}, 'pending', ${input.estimatedRows},
        ${totalBatches}, ${traceId}, ${sql.json(input.rule)}
      where not exists (select 1 from existing)
      returning id, trace_id, file_name, status, total_rows, processed_rows, success_rows,
        failed_rows, total_batches, completed_batches, degraded, created_at, completed_at,
        false as file_persisted
    ), new_outbox as (
      insert into event_outbox (id, aggregate_id, event_type, trace_id, payload, next_retry_at)
      select ${eventId}, ${taskId}, 'ImportTaskCreated', ${traceId},
        ${sql.json({ task_id: taskId, trace_id: traceId })}, ${deferredUntil}
      from new_task
      returning id
    ), new_trace as (
      insert into trace_events (trace_id, task_id, event_name, event_status, message, metadata)
      select ${traceId}, ${taskId}, 'ImportTaskCreated', 'success',
        '上传接口已在同一事务创建任务和 Outbox 事件，文件上传完成后激活投递',
        ${sql.json({ estimated_rows: input.estimatedRows, file_hash: input.fileHash, deferred_file: true })}
      from new_task
    )
    select existing.id, existing.trace_id, existing.file_name, existing.status, existing.total_rows,
      existing.processed_rows, existing.success_rows, existing.failed_rows, existing.total_batches,
      existing.completed_batches, existing.degraded, existing.created_at, existing.completed_at,
      true as duplicated, existing.file_persisted
    from existing
    union all
    select new_task.id, new_task.trace_id, new_task.file_name, new_task.status, new_task.total_rows,
      new_task.processed_rows, new_task.success_rows, new_task.failed_rows, new_task.total_batches,
      new_task.completed_batches, new_task.degraded, new_task.created_at, new_task.completed_at,
      false as duplicated, new_task.file_persisted
    from new_task
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("任务创建失败。");
  return { task: mapTask(row), duplicated: row.duplicated, filePersisted: row.file_persisted };
}

export async function createImportTaskFast(input: ImportTaskInitInput): Promise<ImportTaskSnapshot> {
  return (await createOrReuseImportTaskFast(input)).task;
}

export async function persistImportFile(taskId: string, mimeType: string, fileBytes: Uint8Array) {
  const sql = requireSql();
  await sql`
    insert into import_files (task_id, mime_type, content, size_bytes)
    values (${taskId}, ${mimeType}, ${fileBytes}, ${fileBytes.byteLength})
    on conflict (task_id) do update set
      mime_type = excluded.mime_type, content = excluded.content, size_bytes = excluded.size_bytes
  `;
}

export async function persistImportFileAndActivate(
  taskId: string,
  mimeType: string,
  fileBytes: Uint8Array,
  fileHash: string,
  options: { delivery?: "queue" | "serverless" } = {}
) {
  const sql = requireSql();
  const delivery = options.delivery ?? "queue";
  return sql.begin(async (tx) => {
    const tasks = await tx<{ trace_id: string; file_hash: string }[]>`
      select trace_id, file_hash from import_tasks where id = ${taskId} limit 1
    `;
    const task = tasks[0];
    if (!task) throw new Error("导入任务不存在。");
    if (task.file_hash !== fileHash) throw new Error("上传文件与任务指纹不一致。");

    await tx`
      insert into import_files (task_id, mime_type, content, size_bytes)
      values (${taskId}, ${mimeType}, ${fileBytes}, ${fileBytes.byteLength})
      on conflict (task_id) do update set
        mime_type = excluded.mime_type, content = excluded.content, size_bytes = excluded.size_bytes
    `;
    await tx`
      update event_outbox
      set status = ${delivery === "queue" ? "pending" : "sent"},
        next_retry_at = now(),
        sent_at = ${delivery === "queue" ? null : new Date()},
        last_error = null
      where aggregate_id = ${taskId} and event_type = 'ImportTaskCreated'
        and status in ('pending', 'failed')
    `;
    await tx`
      insert into trace_events (trace_id, task_id, event_name, event_status, message, metadata)
      values (
        ${task.trace_id}, ${taskId}, 'ImportFilePersisted', 'success',
        ${delivery === "queue" ? "原始文件已持久化，Outbox 已激活" : "原始文件已持久化，已转交 Vercel 兜底处理"},
        ${tx.json({ size_bytes: fileBytes.byteLength, file_hash: fileHash, delivery })}
      )
    `;
    return { traceId: task.trace_id };
  });
}

export async function getImportTask(taskId: string): Promise<ImportTaskSnapshot | null> {
  await ensureImportSchema();
  const sql = requireSql();
  const rows = await sql<Parameters<typeof mapTask>[0][]>`
    select id, trace_id, file_name, status, total_rows, processed_rows, success_rows,
      failed_rows, total_batches, completed_batches, degraded, created_at, completed_at
    from import_tasks where id = ${taskId} limit 1
  `;
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function listImportTasks(limit = 50): Promise<ImportTaskSnapshot[]> {
  await ensureImportSchema();
  const sql = requireSql();
  const rows = await sql<Parameters<typeof mapTask>[0][]>`
    select id, trace_id, file_name, status, total_rows, processed_rows, success_rows,
      failed_rows, total_batches, completed_batches, degraded, created_at, completed_at
    from import_tasks order by created_at desc limit ${Math.max(1, Math.min(limit, 100))}
  `;
  return rows.map(mapTask);
}

export async function getParsedTaskPayload(taskId: string): Promise<ParsedTaskPayload | null> {
  const lookup = await getParsedTaskLookup(taskId);
  return lookup.kind === "ready" ? lookup.payload : null;
}

export async function getParsedTaskLookup(taskId: string): Promise<ParsedTaskLookup> {
  await ensureImportSchema();
  const sql = requireSql();
  const rows = await sql<{
    id: string;
    trace_id: string;
    file_name: string;
    mime_type: string | null;
    content: Uint8Array | null;
    rule_payload: ParsedTaskPayload["rule"];
  }[]>`
    select t.id, t.trace_id, t.file_name, f.mime_type, f.content, t.rule_payload
    from import_tasks t
    left join import_files f on f.task_id = t.id
    where t.id = ${taskId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return { kind: "missing" };
  if (!row.content || !row.mime_type) return { kind: "file-pending", taskId: row.id, traceId: row.trace_id };
  return {
    kind: "ready",
    payload: {
      taskId: row.id,
      traceId: row.trace_id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      fileBytes: row.content,
      rule: row.rule_payload
    }
  };
}

export async function persistParsedRows(taskId: string, traceId: string, rows: ParsedOrderRow[], parseDurationMs: number, ruleDurationMs: number) {
  await ensureImportSchema();
  const sql = requireSql();
  const size = batchSize();
  const units: ImportBatchPayload[] = [];
  for (let index = 0; index < rows.length; index += size) {
    units.push({
      task_id: taskId,
      trace_id: traceId,
      unit_id: `unit_${String(units.length + 1).padStart(4, "0")}`,
      batch_index: units.length + 1,
      start_row: index + 1,
      end_row: Math.min(rows.length, index + size),
      parse_duration_ms: parseDurationMs,
      rule_duration_ms: ruleDurationMs
    });
  }

  await sql.begin(async (tx) => {
    await tx`delete from import_task_rows where task_id = ${taskId}`;
    await tx`delete from import_task_batches where task_id = ${taskId}`;
    for (let index = 0; index < rows.length; index += size) {
      const records = rows.slice(index, index + size).map((row, offset) => ({
        row_number: index + offset + 1,
        payload: row
      }));
      await tx`
        insert into import_task_rows (task_id, row_number, payload)
        select ${taskId}, x.row_number, x.payload
        from jsonb_to_recordset(${tx.json(records)}::jsonb) as x(row_number integer, payload jsonb)
        on conflict (task_id, row_number) do update set payload = excluded.payload
      `;
    }

    if (units.length) {
      await tx`
        insert into import_task_batches (task_id, unit_id, batch_index, start_row, end_row)
        select ${taskId}, x.unit_id, x.batch_index, x.start_row, x.end_row
        from jsonb_to_recordset(${tx.json(units)}::jsonb)
          as x(unit_id text, batch_index integer, start_row integer, end_row integer)
        on conflict (task_id, unit_id) do nothing
      `;
      const events = units.map((unit) => ({
        id: `evt_${randomUUID()}`,
        aggregate_id: taskId,
        event_type: "ImportBatchCreated",
        trace_id: traceId,
        payload: unit
      }));
      await tx`
        insert into event_outbox (id, aggregate_id, event_type, trace_id, payload)
        select x.id, x.aggregate_id, x.event_type, x.trace_id, x.payload
        from jsonb_to_recordset(${tx.json(events)}::jsonb)
          as x(id text, aggregate_id text, event_type text, trace_id text, payload jsonb)
        on conflict (id) do nothing
      `;
    }

    await tx`
      update import_tasks set
        status = ${units.length ? "processing" : "failed"},
        total_rows = ${rows.length},
        total_batches = ${units.length},
        processed_rows = 0,
        success_rows = 0,
        failed_rows = 0,
        completed_batches = 0,
        last_heartbeat_at = now()
      where id = ${taskId}
    `;
    await tx`
      insert into trace_events (trace_id, task_id, event_name, event_status, message, metadata)
      values (
        ${traceId}, ${taskId}, 'ImportTaskParsed', ${units.length ? "success" : "failed"},
        ${units.length ? `规则引擎解析完成，创建 ${units.length} 个处理单元` : "规则引擎没有解析出有效行"},
        ${tx.json({ total_rows: rows.length, parse_duration_ms: parseDurationMs, rule_duration_ms: ruleDurationMs })}
      )
    `;
  });
  return units;
}

export async function claimOutboxEvents(limit = 20): Promise<OutboxRecord[]> {
  await ensureImportSchema();
  const sql = requireSql();
  return sql<OutboxRecord[]>`
    with picked as (
      select id from event_outbox
      where status in ('pending', 'failed') and next_retry_at <= now()
      order by created_at
      for update skip locked
      limit ${Math.max(1, Math.min(limit, 100))}
    )
    update event_outbox o set status = 'sending'
    from picked where o.id = picked.id
    returning o.id, o.aggregate_id, o.event_type, o.payload, o.trace_id, o.retry_count
  `;
}

export async function markOutboxSent(id: string) {
  const sql = requireSql();
  await sql`
    with sent as (
      update event_outbox set status = 'sent', sent_at = now(), last_error = null
      where id = ${id}
      returning aggregate_id, trace_id, event_type, payload
    )
    insert into trace_events (trace_id, task_id, unit_id, event_name, event_status, message, metadata)
    select trace_id, aggregate_id, nullif(payload ->> 'unit_id', ''),
      'QueueJobEnqueued', 'success', event_type || ' 已投递到 BullMQ',
      jsonb_build_object('outbox_id', ${id}, 'event_type', event_type)
    from sent
  `;
}

export async function recordTraceEvent(input: {
  traceId: string;
  taskId: string;
  unitId?: string;
  eventName: string;
  eventStatus: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const sql = requireSql();
  await sql`
    insert into trace_events (trace_id, task_id, unit_id, event_name, event_status, message, metadata)
    values (
      ${input.traceId}, ${input.taskId}, ${input.unitId ?? null}, ${input.eventName},
      ${input.eventStatus}, ${input.message.slice(0, 1_000)}, ${sql.json(input.metadata ?? {})}
    )
  `;
}

export async function markOutboxForTaskSent(taskId: string, eventType: string) {
  const sql = requireSql();
  await sql`
    update event_outbox
    set status = 'sent', sent_at = coalesce(sent_at, now()), last_error = null
    where aggregate_id = ${taskId} and event_type = ${eventType} and status in ('pending', 'sending', 'failed')
  `;
}

export async function markOutboxFailed(id: string, error: string) {
  const sql = requireSql();
  await sql`
    update event_outbox set status = 'failed', retry_count = retry_count + 1,
      next_retry_at = now() + make_interval(secs => least(300, power(2, retry_count + 1)::integer)),
      last_error = ${error.slice(0, 1_000)}
    where id = ${id}
  `;
}

export async function claimBatch(taskId: string, unitId: string) {
  await ensureImportSchema();
  const sql = requireSql();
  const rows = await sql<{ batch_index: number; start_row: number; end_row: number; retry_count: number }[]>`
    update import_task_batches set status = 'processing', locked_at = now(), last_error = null
    where task_id = ${taskId} and unit_id = ${unitId}
      and (status = 'pending' or (status = 'processing' and locked_at < now() - interval '5 minutes'))
    returning batch_index, start_row, end_row, retry_count
  `;
  return rows[0] ?? null;
}

export async function loadBatchRows(taskId: string, startRow: number, endRow: number): Promise<ParsedOrderRow[]> {
  const sql = requireSql();
  const rows = await sql<{ payload: ParsedOrderRow }[]>`
    select payload from import_task_rows
    where task_id = ${taskId} and row_number between ${startRow} and ${endRow}
    order by row_number
  `;
  return rows.map((row) => row.payload);
}

export async function findValidSkuCodes(codes: string[]) {
  const sql = requireSql();
  const uniqueCodes = [...new Set(codes.filter(Boolean))];
  if (!uniqueCodes.length) return { codes: new Set<string>(), degraded: false };
  try {
    const rows = await sql.begin(async (tx) => {
      await tx`set local statement_timeout = '3s'`;
      return tx<{ sku_code: string }[]>`
        select sku_code from sku_master where sku_code = any(${sql.array(uniqueCodes)})
      `;
    });
    return { codes: new Set(rows.map((row) => row.sku_code)), degraded: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|connection|ECONN|terminating/i.test(message)) return { codes: new Set(uniqueCodes), degraded: true };
    throw error;
  }
}

export async function findExistingExternalCodes(codes: string[]) {
  const sql = requireSql();
  const uniqueCodes = [...new Set(codes.filter(Boolean))];
  if (!uniqueCodes.length) return [];
  const rows = await sql<{ external_code: string }[]>`
    select external_code from imported_orders where external_code = any(${sql.array(uniqueCodes)})
  `;
  return rows.map((row) => row.external_code);
}

function stableOrderId(taskId: string, group: OrderGroup, index: number) {
  const source = group.externalCode || `${taskId}:${index}:${group.rowIds.join(",")}`;
  return `order_${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

export async function completeBatch(input: {
  taskId: string;
  traceId: string;
  unitId: string;
  batchIndex: number;
  sourceRowCount: number;
  groups: OrderGroup[];
  errors: ImportErrorInput[];
  performance: BatchPerformanceInput;
  degraded: boolean;
}) {
  const sql = requireSql();
  return sql.begin(async (tx) => {
    const claimed = await tx<{ id: number }[]>`
      update import_task_batches set status = 'completed', completed_at = now(),
        result_success_rows = ${input.sourceRowCount - new Set(input.errors.filter((error) => !error.errorCode.startsWith("W")).map((error) => error.rowNumber)).size},
        result_failed_rows = ${new Set(input.errors.filter((error) => !error.errorCode.startsWith("W")).map((error) => error.rowNumber)).size}
      where task_id = ${input.taskId} and unit_id = ${input.unitId} and status = 'processing'
      returning id
    `;
    if (!claimed.length) return { applied: false };

    const submittedAt = new Date().toISOString();
    if (input.groups.length) {
      const orders = input.groups.map((group, index) => {
        const normalized = { ...group, id: stableOrderId(input.taskId, group, index), submittedAt };
        return {
          id: normalized.id,
          external_code: normalized.externalCode ?? null,
          recipient_name: normalized.recipientName ?? null,
          store_name: normalized.storeName ?? null,
          submitted_at: submittedAt,
          payload: normalized
        };
      });
      await tx`
        insert into imported_orders (id, external_code, recipient_name, store_name, submitted_at, payload)
        select x.id, x.external_code, x.recipient_name, x.store_name, x.submitted_at, x.payload
        from jsonb_to_recordset(${tx.json(orders)}::jsonb)
          as x(id text, external_code text, recipient_name text, store_name text, submitted_at timestamptz, payload jsonb)
        on conflict (id) do update set payload = excluded.payload, submitted_at = excluded.submitted_at
      `;
    }

    if (input.errors.length) {
      const errors = input.errors.map((error) =>
        toImportErrorRecord(error, redact(error.fieldName, error.rawValue))
      );
      await tx`
        insert into import_task_errors (
          task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, trace_id
        )
        select x.task_id, x.unit_id, x.batch_index, x.row_number, x.field_name, x.raw_value,
          x.error_code, x.error_reason, x.trace_id
        from jsonb_to_recordset(${tx.json(errors)}::jsonb) as x(
          task_id text, unit_id text, batch_index integer, row_number integer, field_name text,
          raw_value text, error_code text, error_reason text, trace_id text
        )
        on conflict do nothing
      `;
    }

    const perf = input.performance;
    await tx`
      insert into batch_performance_log (
        task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms,
        insert_duration_ms, total_duration_ms, status, trace_id
      ) values (
        ${perf.taskId}, ${perf.unitId}, ${perf.batchIndex}, ${perf.parseDurationMs}, ${perf.ruleDurationMs},
        ${perf.validateDurationMs}, ${perf.insertDurationMs}, ${perf.totalDurationMs}, ${perf.status}, ${perf.traceId}
      )
      on conflict (task_id, unit_id) do update set
        validate_duration_ms = excluded.validate_duration_ms,
        insert_duration_ms = excluded.insert_duration_ms,
        total_duration_ms = excluded.total_duration_ms,
        status = excluded.status
    `;

    const failedRows = new Set(input.errors.filter((error) => !error.errorCode.startsWith("W")).map((error) => error.rowNumber)).size;
    const successRows = input.sourceRowCount - failedRows;
    const taskRows = await tx<{ total_batches: number; completed_batches: number; failed_rows: number }[]>`
      update import_tasks set
        processed_rows = processed_rows + ${input.sourceRowCount},
        success_rows = success_rows + ${successRows},
        failed_rows = failed_rows + ${failedRows},
        completed_batches = completed_batches + 1,
        degraded = degraded or ${input.degraded},
        last_heartbeat_at = now()
      where id = ${input.taskId}
      returning total_batches, completed_batches, failed_rows
    `;
    const task = taskRows[0];
    if (task && task.completed_batches >= task.total_batches) {
      await tx`
        update import_tasks set status = ${task.failed_rows > 0 ? "partial_success" : "completed"}, completed_at = now()
        where id = ${input.taskId}
      `;
    }
    await tx`
      insert into trace_events (trace_id, task_id, unit_id, event_name, event_status, message, metadata)
      values (
        ${input.traceId}, ${input.taskId}, ${input.unitId}, 'ImportBatchSucceeded',
        ${failedRows ? "partial_success" : "success"},
        ${`处理单元完成：成功 ${successRows} 行，失败 ${failedRows} 行`},
        ${tx.json({ success_rows: successRows, failed_rows: failedRows, degraded: input.degraded, total_duration_ms: perf.totalDurationMs })}
      )
    `;
    return { applied: true, successRows, failedRows };
  });
}

export async function recordInsertDuration(taskId: string, unitId: string, insertDurationMs: number, totalDurationMs?: number) {
  const sql = requireSql();
  await sql`
    update batch_performance_log set
      insert_duration_ms = ${insertDurationMs},
      total_duration_ms = ${totalDurationMs ?? insertDurationMs}
    where task_id = ${taskId} and unit_id = ${unitId}
  `;
}

export async function reactivateOutboxForTask(taskId: string, eventType: string) {
  const sql = requireSql();
  await sql`
    update event_outbox
    set status = 'pending', next_retry_at = now(), sent_at = null,
      last_error = 'Serverless fallback failed; returned to queue delivery'
    where aggregate_id = ${taskId} and event_type = ${eventType} and status = 'sent'
  `;
}

export async function failBatch(taskId: string, unitId: string, traceId: string, error: string, maxRetries = 3) {
  const sql = requireSql();
  return sql.begin(async (tx) => {
    const rows = await tx<{ retry_count: number; status: string }[]>`
      update import_task_batches set
        retry_count = retry_count + 1,
        status = case when retry_count + 1 >= ${maxRetries} then 'failed' else 'pending' end,
        last_error = ${error.slice(0, 1_000)},
        locked_at = null
      where task_id = ${taskId} and unit_id = ${unitId}
      returning retry_count, status
    `;
    const batch = rows[0];
    await tx`
      insert into trace_events (trace_id, task_id, unit_id, event_name, event_status, message, metadata)
      values (
        ${traceId}, ${taskId}, ${unitId}, 'ImportBatchFailed', ${batch?.status === "failed" ? "failed" : "retrying"},
        ${error.slice(0, 1_000)}, ${tx.json({ retry_count: batch?.retry_count ?? 0 })}
      )
    `;
    if (batch?.status === "failed") {
      const terminal = await tx<{ remaining: number }[]>`
        select count(*) filter (where status in ('pending', 'processing'))::int as remaining
        from import_task_batches where task_id = ${taskId}
      `;
      if ((terminal[0]?.remaining ?? 1) === 0) {
        await tx`
          update import_tasks set
            status = case when success_rows > 0 then 'partial_success' else 'failed' end,
            completed_at = now()
          where id = ${taskId}
        `;
      }
    }
    return batch;
  });
}

export async function failTask(taskId: string, traceId: string, error: string) {
  const sql = requireSql();
  await sql.begin(async (tx) => {
    await tx`update import_tasks set status = 'failed', completed_at = now() where id = ${taskId}`;
    await tx`
      insert into trace_events (trace_id, task_id, event_name, event_status, message)
      values (${traceId}, ${taskId}, 'ImportTaskFailed', 'failed', ${error.slice(0, 1_000)})
    `;
  });
}

export async function listImportErrors(taskId: string, options: { batch?: number; code?: string; page: number; pageSize: number }) {
  await ensureImportSchema();
  const sql = requireSql();
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, Math.min(options.pageSize, 100));
  const rows = await sql<{
    id: number; unit_id: string; batch_index: number; row_number: number; field_name: string;
    raw_value: string; error_code: string; error_reason: string; trace_id: string; created_at: Date; total: number;
  }[]>`
    select *, count(*) over()::int as total from import_task_errors
    where task_id = ${taskId}
      and (${options.batch ?? 0} = 0 or batch_index = ${options.batch ?? 0})
      and (${options.code ?? ""} = '' or error_code = ${options.code ?? ""})
    order by row_number, id
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `;
  return {
    page,
    page_size: pageSize,
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _total, created_at, ...row }) => ({ ...row, created_at: created_at.toISOString() }))
  };
}

export async function listImportBatches(taskId: string) {
  await ensureImportSchema();
  const sql = requireSql();
  return sql`
    select b.unit_id, b.batch_index, b.start_row, b.end_row, b.status, b.retry_count,
      b.result_success_rows, b.result_failed_rows, b.last_error, b.completed_at,
      p.parse_duration_ms, p.rule_duration_ms, p.validate_duration_ms, p.insert_duration_ms, p.total_duration_ms
    from import_task_batches b
    left join batch_performance_log p on p.task_id = b.task_id and p.unit_id = b.unit_id
    where b.task_id = ${taskId}
    order by b.batch_index
  `;
}

export async function getTraceEvents(traceId: string) {
  await ensureImportSchema();
  const sql = requireSql();
  const rows = await sql<{ occurred_at: Date }[]>`
    select event_name, event_status, task_id, unit_id, message, metadata, occurred_at
    from trace_events where trace_id = ${traceId} order by occurred_at
  `;
  return rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() }));
}

export async function monitorSummary() {
  await ensureImportSchema();
  const sql = requireSql();
  const [throughput, throughputSeries, queue, latency, errors, slowBatches] = await Promise.all([
    sql`select coalesce(sum(result_success_rows), 0)::int as rows from import_task_batches where completed_at >= now() - interval '1 minute'`,
    sql`
      select to_char(date_trunc('minute', completed_at), 'YYYY-MM-DD"T"HH24:MI') as minute,
        coalesce(sum(result_success_rows), 0)::int as rows
      from import_task_batches
      where completed_at >= now() - interval '5 minutes'
      group by 1 order by 1
    `,
    sql`select status, count(*)::int as units, coalesce(sum(end_row - start_row + 1), 0)::int as rows from import_task_batches group by status`,
    sql`
      select
        (percentile_cont(0.5) within group (order by parse_duration_ms) filter (where parse_duration_ms > 0))::int as parse_p50,
        (percentile_cont(0.95) within group (order by parse_duration_ms) filter (where parse_duration_ms > 0))::int as parse_p95,
        (percentile_cont(0.99) within group (order by parse_duration_ms) filter (where parse_duration_ms > 0))::int as parse_p99,
        (percentile_cont(0.5) within group (order by rule_duration_ms) filter (where rule_duration_ms > 0))::int as rule_p50,
        (percentile_cont(0.95) within group (order by rule_duration_ms) filter (where rule_duration_ms > 0))::int as rule_p95,
        (percentile_cont(0.99) within group (order by rule_duration_ms) filter (where rule_duration_ms > 0))::int as rule_p99,
        (percentile_cont(0.5) within group (order by validate_duration_ms) filter (where validate_duration_ms > 0))::int as validate_p50,
        (percentile_cont(0.95) within group (order by validate_duration_ms) filter (where validate_duration_ms > 0))::int as validate_p95,
        (percentile_cont(0.99) within group (order by validate_duration_ms) filter (where validate_duration_ms > 0))::int as validate_p99,
        (percentile_cont(0.5) within group (order by insert_duration_ms) filter (where insert_duration_ms > 0))::int as insert_p50,
        (percentile_cont(0.95) within group (order by insert_duration_ms) filter (where insert_duration_ms > 0))::int as insert_p95,
        (percentile_cont(0.99) within group (order by insert_duration_ms) filter (where insert_duration_ms > 0))::int as insert_p99
      from batch_performance_log where created_at >= now() - interval '1 hour'
    `,
    sql`select error_code, count(*)::int as count from import_task_errors where created_at >= now() - interval '1 hour' group by error_code order by count desc`,
    sql`
      select p.task_id, t.file_name, p.unit_id, p.batch_index, p.validate_duration_ms,
        p.insert_duration_ms, p.total_duration_ms, p.status, p.created_at
      from batch_performance_log p
      left join import_tasks t on t.id = p.task_id
      where p.created_at >= now() - interval '24 hours'
      order by p.total_duration_ms desc
      limit 10
    `
  ]);
  return {
    generated_at: new Date().toISOString(),
    throughput_per_minute: Number(throughput[0]?.rows ?? 0),
    throughput_series: fillMinuteGaps(throughputSeries.map((point) => ({
      minute: String(point.minute),
      rows: Number(point.rows ?? 0)
    }))),
    queue,
    latency: latency[0] ?? {},
    errors,
    slow_batches: slowBatches.map((row) => ({ ...row, created_at: row.created_at.toISOString() }))
  };
}

export async function recoverStuckBatches() {
  await ensureImportSchema();
  const sql = requireSql();
  return sql`
    update import_task_batches set status = 'pending', locked_at = null,
      retry_count = retry_count + 1, last_error = 'Worker heartbeat timeout; recovered automatically'
    where status = 'processing' and locked_at < now() - interval '5 minutes'
    returning task_id, unit_id
  `;
}

export type TraceSearchOptions = {
  taskId?: string;
  traceId?: string;
  fileName?: string;
  batchIndex?: number;
  rowFrom?: number;
  rowTo?: number;
  errorCode?: string;
  limit?: number;
};

export async function searchTraceEvents(options: TraceSearchOptions) {
  await ensureImportSchema();
  const sql = requireSql();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const tasks = await sql<Parameters<typeof mapTask>[0][]>`
    select id, trace_id, file_name, status, total_rows, processed_rows, success_rows,
      failed_rows, total_batches, completed_batches, degraded, created_at, completed_at
    from import_tasks
    where (${options.taskId ?? ""} = '' or id = ${options.taskId ?? ""})
      and (${options.traceId ?? ""} = '' or trace_id = ${options.traceId ?? ""})
      and (${options.fileName ?? ""} = '' or file_name ilike ${"%" + (options.fileName ?? "") + "%"})
    order by created_at desc limit 20
  `;
  const traceIds = tasks.map((task) => task.trace_id);
  const taskIds = tasks.map((task) => task.id);

  const events = traceIds.length
    ? await sql<{ occurred_at: Date }[]>`
      select event_name, event_status, task_id, unit_id, message, metadata, occurred_at
      from trace_events
      where trace_id = any(${sql.array(traceIds)})
      order by occurred_at desc limit ${limit}
    `
    : [];

  const errors = taskIds.length
    ? await sql<{ created_at: Date }[]>`
      select task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, trace_id, created_at
      from import_task_errors
      where task_id = any(${sql.array(taskIds)})
        and (${options.batchIndex ?? 0} = 0 or batch_index = ${options.batchIndex ?? 0})
        and (${options.errorCode ?? ""} = '' or error_code = ${options.errorCode ?? ""})
        and (${options.rowFrom ?? 0} = 0 or row_number >= ${options.rowFrom ?? 0})
        and (${options.rowTo ?? 0} = 0 or row_number <= ${options.rowTo ?? 0})
      order by row_number limit ${limit}
    `
    : [];

  return {
    tasks: tasks.map(mapTask),
    events: events.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() })),
    errors: errors.map((row) => ({ ...row, created_at: row.created_at.toISOString() }))
  };
}

export async function retryFailedBatches(taskId: string) {
  await ensureImportSchema();
  const sql = requireSql();
  return sql.begin(async (tx) => {
    const taskRows = await tx<{ trace_id: string }[]>`select trace_id from import_tasks where id = ${taskId} limit 1`;
    if (!taskRows[0]) return { retried: 0 };
    const batches = await tx<{ unit_id: string; batch_index: number; start_row: number; end_row: number }[]>`
      update import_task_batches set status = 'pending', locked_at = null, last_error = null
      where task_id = ${taskId} and status = 'failed'
      returning unit_id, batch_index, start_row, end_row
    `;
    for (const batch of batches) {
      await tx`
        insert into event_outbox (id, aggregate_id, event_type, trace_id, payload)
        values (
          ${`evt_${randomUUID()}`}, ${taskId}, 'ImportBatchCreated', ${taskRows[0].trace_id},
          ${tx.json({ task_id: taskId, unit_id: batch.unit_id, batch_index: batch.batch_index, start_row: batch.start_row, end_row: batch.end_row, trace_id: taskRows[0].trace_id })}
        )
      `;
    }
    if (batches.length) {
      await tx`update import_tasks set status = 'processing', completed_at = null, last_heartbeat_at = now() where id = ${taskId}`;
      await tx`
        insert into trace_events (trace_id, task_id, event_name, event_status, message, metadata)
        values (${taskRows[0].trace_id}, ${taskId}, 'ImportTaskRetryRequested', 'success', ${`已重新入队 ${batches.length} 个失败批次`}, ${tx.json({ retried: batches.length })})
      `;
    }
    return { retried: batches.length };
  });
}
