import { getSql } from "@/lib/store";

let importSchemaReady: Promise<void> | null = null;

async function initializeImportSchema() {
  const sql = getSql();
  if (!sql) throw new Error("异步导入需要配置 DATABASE_URL。");

  await sql`
    create table if not exists sku_master (
      id bigserial primary key,
      sku_code text not null unique,
      name text not null,
      spec text,
      unit text not null default '件',
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists import_tasks (
      id text primary key,
      file_name text not null,
      file_hash text not null,
      status text not null default 'pending',
      total_rows integer not null default 0,
      processed_rows integer not null default 0,
      success_rows integer not null default 0,
      failed_rows integer not null default 0,
      total_batches integer not null default 0,
      completed_batches integer not null default 0,
      trace_id text not null unique,
      degraded boolean not null default false,
      rule_payload jsonb not null,
      created_at timestamptz not null default now(),
      completed_at timestamptz,
      last_heartbeat_at timestamptz not null default now(),
      constraint import_task_progress_valid check (processed_rows = success_rows + failed_rows)
    )
  `;
  await sql`create index if not exists idx_import_tasks_status_created on import_tasks(status, created_at desc)`;
  await sql`create index if not exists idx_import_tasks_file_hash on import_tasks(file_hash)`;
  await sql`
    create table if not exists import_files (
      task_id text primary key references import_tasks(id) on delete cascade,
      mime_type text not null,
      content bytea not null,
      size_bytes integer not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists import_task_batches (
      id bigserial primary key,
      task_id text not null references import_tasks(id) on delete cascade,
      unit_id text not null,
      batch_index integer not null,
      start_row integer not null,
      end_row integer not null,
      status text not null default 'pending',
      retry_count integer not null default 0,
      result_success_rows integer not null default 0,
      result_failed_rows integer not null default 0,
      locked_at timestamptz,
      completed_at timestamptz,
      last_error text,
      unique(task_id, unit_id)
    )
  `;
  await sql`create index if not exists idx_import_batches_task_status on import_task_batches(task_id, status)`;
  await sql`
    create table if not exists import_task_rows (
      id bigserial primary key,
      task_id text not null references import_tasks(id) on delete cascade,
      row_number integer not null,
      payload jsonb not null,
      unique(task_id, row_number)
    )
  `;
  await sql`create index if not exists idx_import_rows_task_row on import_task_rows(task_id, row_number)`;
  await sql`
    create table if not exists import_task_errors (
      id bigserial primary key,
      task_id text not null references import_tasks(id) on delete cascade,
      unit_id text not null,
      batch_index integer not null,
      row_number integer not null,
      field_name text not null,
      raw_value text,
      error_code text not null,
      error_reason text not null,
      trace_id text not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists idx_import_errors_task_unit on import_task_errors(task_id, unit_id)`;
  await sql`create index if not exists idx_import_errors_code on import_task_errors(error_code)`;
  await sql`create unique index if not exists idx_import_errors_idempotent on import_task_errors(task_id, unit_id, row_number, field_name, error_code)`;
  await sql`
    create table if not exists event_outbox (
      id text primary key,
      aggregate_id text not null,
      event_type text not null,
      schema_version integer not null default 1,
      trace_id text not null,
      payload jsonb not null,
      status text not null default 'pending',
      retry_count integer not null default 0,
      next_retry_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      last_error text
    )
  `;
  await sql`create index if not exists idx_outbox_dispatch on event_outbox(status, next_retry_at) where status in ('pending', 'failed')`;
  await sql`
    create table if not exists batch_performance_log (
      id bigserial primary key,
      task_id text not null references import_tasks(id) on delete cascade,
      unit_id text not null,
      batch_index integer not null,
      parse_duration_ms integer not null default 0,
      rule_duration_ms integer not null default 0,
      validate_duration_ms integer not null default 0,
      insert_duration_ms integer not null default 0,
      total_duration_ms integer not null default 0,
      status text not null,
      trace_id text not null,
      created_at timestamptz not null default now(),
      unique(task_id, unit_id)
    )
  `;
  await sql`create index if not exists idx_batch_perf_task_unit on batch_performance_log(task_id, unit_id)`;
  await sql`
    create table if not exists trace_events (
      id bigserial primary key,
      trace_id text not null,
      task_id text not null,
      unit_id text,
      event_name text not null,
      event_status text not null,
      message text not null,
      metadata jsonb,
      occurred_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists idx_trace_events_trace_time on trace_events(trace_id, occurred_at)`;
  await sql`create index if not exists idx_imported_orders_external on imported_orders(external_code) where external_code is not null`;
}

export async function ensureImportSchema() {
  importSchemaReady ||= initializeImportSchema().catch((error) => {
    importSchemaReady = null;
    throw error;
  });
  await importSchemaReady;
}
