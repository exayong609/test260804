import {
  getImportTask,
  listImportBatches,
  markOutboxForTaskSent,
  reactivateOutboxForTask,
  recoverStuckBatches
} from "@/lib/import-repository";
import { processImportBatch, processImportTask } from "@/lib/import-processor";

export async function processImportTaskInBackground(taskId: string) {
  await recoverStuckBatches();
  await markOutboxForTaskSent(taskId, "ImportTaskCreated");
  let parsed: Awaited<ReturnType<typeof processImportTask>>;
  try {
    parsed = await processImportTask(taskId);
  } catch (error) {
    await reactivateOutboxForTask(taskId, "ImportTaskCreated");
    throw error;
  }

  const task = await getImportTask(taskId);
  if (!task) return;
  const batches = await listImportBatches(taskId);
  const parseDurationMs = "parseDurationMs" in parsed ? parsed.parseDurationMs : 0;
  const ruleDurationMs = "ruleDurationMs" in parsed ? parsed.ruleDurationMs : 0;
  await markOutboxForTaskSent(taskId, "ImportBatchCreated");
  const concurrency = 2;
  try {
    for (let index = 0; index < batches.length; index += concurrency) {
      await Promise.all(
        batches.slice(index, index + concurrency).map((batch) =>
          processImportBatch({
            task_id: taskId,
            trace_id: task.trace_id,
            unit_id: batch.unit_id,
            batch_index: batch.batch_index,
            start_row: batch.start_row,
            end_row: batch.end_row,
            parse_duration_ms: parseDurationMs,
            rule_duration_ms: ruleDurationMs
          })
        )
      );
    }
  } catch (error) {
    await reactivateOutboxForTask(taskId, "ImportBatchCreated");
    throw error;
  }
}
