import { NextResponse } from "next/server";
import { monitorSummary } from "@/lib/import-repository";

export async function GET() {
  try {
    return NextResponse.json(await monitorSummary());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "监控聚合失败。" }, { status: 503 });
  }
}
