import { NextResponse } from "next/server";
import { getImportTask, listImportBatches } from "@/lib/import-repository";

export async function GET(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  try {
    if (!(await getImportTask(taskId))) return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    return NextResponse.json({ task_id: taskId, items: await listImportBatches(taskId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "批次查询失败。" }, { status: 503 });
  }
}
