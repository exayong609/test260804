import { Queue } from "bullmq";
import IORedis from "ioredis";
import { claimOutboxEvents, markOutboxFailed, markOutboxSent } from "@/lib/import-repository";

export const IMPORT_QUEUE_NAME = "v2-import-pipeline";

const globalQueue = globalThis as typeof globalThis & {
  __importRedis?: IORedis;
  __importQueue?: Queue;
};

export function getRedisConnection() {
  if (!process.env.REDIS_URL) throw new Error("异步导入需要配置 REDIS_URL。");
  globalQueue.__importRedis ||= new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true
  });
  return globalQueue.__importRedis;
}

export function getImportQueue() {
  globalQueue.__importQueue ||= new Queue(IMPORT_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 604_800, count: 5_000 }
    }
  });
  return globalQueue.__importQueue;
}

export async function dispatchOutboxEvents(limit = 20) {
  const events = await claimOutboxEvents(limit);
  const queue = getImportQueue();
  let sent = 0;
  for (const event of events) {
    try {
      await queue.add(event.event_type, { ...event.payload, outbox_id: event.id }, { jobId: event.id });
      await markOutboxSent(event.id);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markOutboxFailed(event.id, message);
    }
  }
  return { claimed: events.length, sent };
}
