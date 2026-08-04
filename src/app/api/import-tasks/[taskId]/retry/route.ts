import { NextResponse } from "next/server";
import { retryFailedBatches } from "@/lib/import-repository";

export async function POST(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  try {
    return NextResponse.json({ task_id: taskId, ...(await retryFailedBatches(taskId)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "失败批次重试失败。" }, { status: 503 });
  }
}
