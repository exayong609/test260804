import { NextResponse } from "next/server";
import { getImportTask, listImportErrors } from "@/lib/import-repository";

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  try {
    if (!(await getImportTask(taskId))) return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    const params = new URL(request.url).searchParams;
    const result = await listImportErrors(taskId, {
      batch: Number(params.get("batch") || 0) || undefined,
      code: params.get("error_code") || undefined,
      page: Number(params.get("page") || 1),
      pageSize: Number(params.get("page_size") || 50)
    });
    return NextResponse.json({ task_id: taskId, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "错误明细查询失败。" }, { status: 503 });
  }
}
