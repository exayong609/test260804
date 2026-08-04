import { NextResponse } from "next/server";
import { getImportTask } from "@/lib/import-repository";

const TASK_ID = /^task_[0-9a-f-]{36}$/i;

export async function GET(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  if (!TASK_ID.test(taskId)) return NextResponse.json({ error: "非法 task_id。" }, { status: 400 });
  try {
    const task = await getImportTask(taskId);
    return task ? NextResponse.json(task) : NextResponse.json({ error: "任务不存在。" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "任务查询失败。" }, { status: 503 });
  }
}
