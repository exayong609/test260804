import {
  getImportTask,
  listImportBatches,
  markOutboxForTaskSent,
  recoverStuckBatches
} from "@/lib/import-repository";
import { processImportBatch, processImportTask } from "@/lib/import-processor";

export async function processImportTaskInBackground(taskId: string) {
  await recoverStuckBatches();
  await processImportTask(taskId);
  await markOutboxForTaskSent(taskId, "ImportTaskCreated");

  const task = await getImportTask(taskId);
  if (!task) return;
  const batches = await listImportBatches(taskId);
  const concurrency = 2;
  for (let index = 0; index < batches.length; index += concurrency) {
    await Promise.all(
      batches.slice(index, index + concurrency).map((batch) =>
        processImportBatch({
          task_id: taskId,
          trace_id: task.trace_id,
          unit_id: batch.unit_id,
          batch_index: batch.batch_index,
          start_row: batch.start_row,
          end_row: batch.end_row
        })
      )
    );
  }
  await markOutboxForTaskSent(taskId, "ImportBatchCreated");
}
