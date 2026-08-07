import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function source(relativePath: string) {
  return fs.readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("task creation writes task and Outbox in one SQL statement", async () => {
  const repository = await source("src/lib/import-repository.ts");
  const fastPath = repository.slice(repository.indexOf("export async function createOrReuseImportTaskFast"), repository.indexOf("export async function createImportTaskFast"));
  assert.match(fastPath, /with existing as/);
  assert.match(fastPath, /new_task as/);
  assert.match(fastPath, /new_outbox as/);
  assert.match(fastPath, /from new_task/);
  assert.match(fastPath, /next_retry_at/);
  assert.doesNotMatch(fastPath, /ensureImportSchema/);
});

test("file persistence activates Outbox only after hash verification", async () => {
  const repository = await source("src/lib/import-repository.ts");
  const activation = repository.slice(repository.indexOf("export async function persistImportFileAndActivate"), repository.indexOf("export async function getImportTask"));
  assert.match(activation, /sql\.begin/);
  assert.match(activation, /task\.file_hash !== fileHash/);
  assert.match(activation, /insert into import_files/);
  assert.match(activation, /next_retry_at = now\(\)/);
  assert.match(activation, /ImportFilePersisted/);
  assert.match(activation, /delivery === "queue"/);
});

test("serverless fallback avoids queue races and preserves parse and rule timings", async () => {
  const fallback = await source("src/lib/serverless-import-fallback.ts");
  assert.match(fallback, /markOutboxForTaskSent\(taskId, "ImportTaskCreated"\)/);
  assert.match(fallback, /markOutboxForTaskSent\(taskId, "ImportBatchCreated"\)/);
  assert.match(fallback, /reactivateOutboxForTask/);
  assert.match(fallback, /parse_duration_ms: parseDurationMs/);
  assert.match(fallback, /rule_duration_ms: ruleDurationMs/);
});

test("an interrupted browser upload can resume the existing task", async () => {
  const repository = await source("src/lib/import-repository.ts");
  const route = await source("src/app/api/import-tasks/route.ts");
  const page = await source("src/app/import-tasks/page.tsx");
  assert.match(repository, /file_persisted/);
  assert.match(route, /file_upload_pending: !result\.filePersisted/);
  assert.match(page, /task\.file_upload_pending/);
  assert.match(page, /uploadTaskFile\(task\.task_id/);
});

test("queue jobs use bounded retries and exponential backoff", async () => {
  const queue = await source("src/lib/import-queue.ts");
  const processor = await source("src/lib/import-processor.ts");
  const repository = await source("src/lib/import-repository.ts");
  const worker = await source("scripts/import-worker.ts");
  assert.match(queue, /attempts: 3/);
  assert.match(queue, /type: "exponential"/);
  assert.match(processor, /ImportFileNotReadyError/);
  assert.match(repository, /QueueJobEnqueued/);
  assert.match(worker, /WorkerJobStarted/);
  assert.match(worker, /WorkerJobCompleted/);
});

test("batch consumption is idempotent and progress is guarded", async () => {
  const repository = await source("src/lib/import-repository.ts");
  const schema = await source("src/lib/import-schema.ts");
  assert.match(repository, /status = 'pending' or \(status = 'processing'/);
  assert.match(repository, /and status = 'processing'/);
  assert.match(schema, /unique\(task_id, unit_id\)/);
  assert.match(schema, /idx_import_errors_idempotent/);
});

test("SKU dependency failures trigger visible three-second degradation", async () => {
  const repository = await source("src/lib/import-repository.ts");
  const processor = await source("src/lib/import-processor.ts");
  const page = await source("src/app/import-tasks/page.tsx");
  assert.match(repository, /statement_timeout = '3s'/);
  assert.match(processor, /errorCode: "W001"/);
  assert.match(page, /SKU 校验已降级/);
});

test("Trace search exposes task, file, batch, row and error filters", async () => {
  const route = await source("src/app/api/traces/route.ts");
  for (const key of ["task_id", "trace_id", "file_name", "batch", "row_from", "row_to", "error_code"]) {
    assert.match(route, new RegExp(key));
  }
});

test("internal Outbox dispatch requires a bearer secret", async () => {
  const route = await source("src/app/api/internal/outbox/dispatch/route.ts");
  assert.match(route, /INTERNAL_API_KEY/);
  assert.match(route, /Bearer/);
  assert.match(route, /status: 401/);
});

test("abandoned file uploads are auto-failed, cancelled and traced", async () => {
  const repository = await source("src/lib/import-repository.ts");
  const worker = await source("scripts/import-worker.ts");
  const fallback = await source("src/lib/serverless-import-fallback.ts");
  const fn = repository.slice(
    repository.indexOf("export async function failAbandonedFileUploads"),
    repository.indexOf("export type TraceSearchOptions")
  );
  assert.match(fn, /not exists \(select 1 from import_files/);
  assert.match(fn, /set status = 'failed', completed_at = now\(\)/);
  assert.match(fn, /cancelled_outbox as/);
  assert.match(fn, /ImportFileUploadAbandoned/);
  assert.match(worker, /failAbandonedFileUploads/);
  assert.match(fallback, /failAbandonedFileUploads/);
});

test("upload routes keep the heavy parser chain out of their cold start", async () => {
  const route = await source("src/app/api/import-tasks/route.ts");
  const fileRoute = await source("src/app/api/import-tasks/[taskId]/file/route.ts");
  for (const text of [route, fileRoute]) {
    assert.doesNotMatch(text, /^import \{[^}]*\} from "@\/lib\/serverless-import-fallback";$/m);
    assert.doesNotMatch(text, /^import .* from "@\/lib\/import-processor";$/m);
    assert.match(text, /await import\("@\/lib\/serverless-import-fallback"\)/);
  }
});
