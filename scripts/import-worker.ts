import { Worker } from "bullmq";
import { dispatchOutboxEvents, getRedisConnection, IMPORT_QUEUE_NAME } from "../src/lib/import-queue";
import { processImportBatch, processImportTask } from "../src/lib/import-processor";
import { recordTraceEvent, recoverStuckBatches } from "../src/lib/import-repository";
import type { ImportBatchPayload } from "../src/lib/import-types";

async function safeRecordTrace(input: Parameters<typeof recordTraceEvent>[0]) {
  try {
    await recordTraceEvent(input);
  } catch (error) {
    console.error(`[trace] ${input.eventName} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
const concurrency = Math.max(1, Math.min(Number(process.env.IMPORT_WORKER_CONCURRENCY || 4), 12));
const connection = getRedisConnection().duplicate();

const worker = new Worker(
  IMPORT_QUEUE_NAME,
  async (job) => {
    const taskId = String(job.data.task_id || "");
    const traceId = String(job.data.trace_id || "");
    const unitId = job.data.unit_id ? String(job.data.unit_id) : undefined;
    if (traceId && taskId) {
      await safeRecordTrace({
        traceId,
        taskId,
        unitId,
        eventName: "WorkerJobStarted",
        eventStatus: "processing",
        message: `${job.name} 开始处理`,
        metadata: { job_id: String(job.id ?? ""), attempt: job.attemptsMade + 1 }
      });
    }
    try {
      let result: unknown;
      if (job.name === "ImportTaskCreated") result = await processImportTask(taskId);
      else if (job.name === "ImportBatchCreated") result = await processImportBatch(job.data as ImportBatchPayload);
      else throw new Error(`不支持的导入事件：${job.name}`);
      if (traceId && taskId) {
        await safeRecordTrace({
          traceId,
          taskId,
          unitId,
          eventName: "WorkerJobCompleted",
          eventStatus: "success",
          message: `${job.name} 处理完成`,
          metadata: { job_id: String(job.id ?? ""), attempt: job.attemptsMade + 1 }
        });
      }
      return result;
    } catch (error) {
      if (traceId && taskId) {
        await safeRecordTrace({
          traceId,
          taskId,
          unitId,
          eventName: "WorkerJobFailed",
          eventStatus: "failed",
          message: error instanceof Error ? error.message : String(error),
          metadata: { job_id: String(job.id ?? ""), attempt: job.attemptsMade + 1 }
        });
      }
      throw error;
    }
  },
  { connection, concurrency }
);

worker.on("completed", (job) => console.log(`[worker] completed ${job.name} ${job.id}`));
worker.on("failed", (job, error) => console.error(`[worker] failed ${job?.name} ${job?.id}: ${error.message}`));
worker.on("error", (error) => console.error(`[worker] error: ${error.message}`));

let dispatching = false;
async function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    const result = await dispatchOutboxEvents(50);
    if (result.claimed) console.log(`[outbox] claimed=${result.claimed} sent=${result.sent}`);
  } finally {
    dispatching = false;
  }
}

await dispatch();
const dispatcher = setInterval(() => void dispatch(), 1_000);
const recovery = setInterval(() => void recoverStuckBatches(), 60_000);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}, shutting down`);
  clearInterval(dispatcher);
  clearInterval(recovery);
  await worker.close();
  await connection.quit();
  await getRedisConnection().quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`[worker] listening queue=${IMPORT_QUEUE_NAME} concurrency=${concurrency}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
