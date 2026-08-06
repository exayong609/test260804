import { NextResponse } from "next/server";
import { searchTraceEvents } from "@/lib/import-repository";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const taskId = params.get("task_id")?.trim() || undefined;
  const traceId = params.get("trace_id")?.trim() || undefined;
  const fileName = params.get("file_name")?.trim() || undefined;
  const batchIndex = Number(params.get("batch") || 0) || undefined;
  const rowFrom = Number(params.get("row_from") || 0) || undefined;
  const rowTo = Number(params.get("row_to") || 0) || undefined;
  const errorCode = params.get("error_code")?.trim() || undefined;

  if (!taskId && !traceId && !fileName && !errorCode) {
    return NextResponse.json({ error: "请提供 task_id、trace_id、file_name 或 error_code 中的至少一个检索条件。" }, { status: 400 });
  }
  if (traceId && !/^trace_[0-9a-f-]{36}$/i.test(traceId)) {
    return NextResponse.json({ error: "非法 trace_id。" }, { status: 400 });
  }

  try {
    const result = await searchTraceEvents({ taskId, traceId, fileName, batchIndex, rowFrom, rowTo, errorCode });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Trace 检索失败。" }, { status: 503 });
  }
}
