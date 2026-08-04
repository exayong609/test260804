import { NextResponse } from "next/server";
import { dispatchOutboxEvents } from "@/lib/import-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.INTERNAL_API_KEY;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await dispatchOutboxEvents(50));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Outbox 投递失败。" }, { status: 503 });
  }
}
