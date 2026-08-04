import { NextResponse } from "next/server";
import { getTraceEvents } from "@/lib/import-repository";

export async function GET(_: Request, context: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await context.params;
  if (!/^trace_[0-9a-f-]{36}$/i.test(traceId)) return NextResponse.json({ error: "非法 trace_id。" }, { status: 400 });
  try {
    const events = await getTraceEvents(traceId);
    return events.length ? NextResponse.json({ trace_id: traceId, events }) : NextResponse.json({ error: "Trace 不存在。" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Trace 查询失败。" }, { status: 503 });
  }
}
