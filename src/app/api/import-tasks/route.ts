import { after, NextResponse } from "next/server";
import { createImportTask, listImportTasks } from "@/lib/import-repository";
import { estimateRowCount, fileHash } from "@/lib/import-upload";
import { listRules } from "@/lib/store";
import type { ParsingRule } from "@/types";
import { processImportTaskInBackground } from "@/lib/serverless-import-fallback";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json({ items: await listImportTasks() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "任务查询失败。" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const started = performance.now();
  try {
    const form = await request.formData();
    const file = form.get("file");
    const ruleId = String(form.get("ruleId") || "");
    const ruleRaw = form.get("rule");
    if (!(file instanceof File)) return NextResponse.json({ error: "请上传文件。" }, { status: 400 });
    if (!/\.(xlsx|xls|docx|pdf)$/i.test(file.name)) {
      return NextResponse.json({ error: "仅支持 xlsx、xls、docx 和 pdf 文件。" }, { status: 400 });
    }

    let rule: ParsingRule | undefined;
    if (typeof ruleRaw === "string" && ruleRaw) rule = JSON.parse(ruleRaw) as ParsingRule;
    if (!rule && ruleId) rule = (await listRules()).find((item) => item.id === ruleId);
    if (!rule) return NextResponse.json({ error: "请选择有效的解析规则。" }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const task = await createImportTask({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      fileBytes: bytes,
      fileHash: fileHash(bytes),
      rule,
      estimatedRows: estimateRowCount(file.name, bytes)
    });
    if (!task) throw new Error("导入任务创建后无法读取任务状态。");
    if (process.env.VERCEL === "1" && process.env.SERVERLESS_IMPORT_FALLBACK !== "false") {
      after(async () => {
        try {
          await processImportTaskInBackground(task.task_id);
        } catch (error) {
          console.error("[serverless-import-fallback] failed", error);
        }
      });
    }
    return NextResponse.json({ ...task, upload_duration_ms: Math.round(performance.now() - started) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "异步任务创建失败。" }, { status: 500 });
  }
}
