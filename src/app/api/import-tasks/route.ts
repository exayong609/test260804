import { after, NextResponse } from "next/server";
import { createImportTaskFast, findTaskByFileHash, listImportTasks, persistImportFile } from "@/lib/import-repository";
import { estimateRowCount, fileHash } from "@/lib/import-upload";
import { getRuleById } from "@/lib/store";
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

    let rulePromise: Promise<ParsingRule | undefined> | null = null;
    if (typeof ruleRaw !== "string" || !ruleRaw) {
      if (!ruleId) return NextResponse.json({ error: "请选择有效的解析规则。" }, { status: 400 });
      rulePromise = getRuleById(ruleId).then((found) => found ?? undefined);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = fileHash(bytes);

    const duplicatePromise = findTaskByFileHash(hash);
    let rule: ParsingRule | undefined;
    if (typeof ruleRaw === "string" && ruleRaw) rule = JSON.parse(ruleRaw) as ParsingRule;
    else rule = await rulePromise!;
    const duplicate = await duplicatePromise;
    if (duplicate) {
      return NextResponse.json(
        { ...duplicate, duplicated: true, notice: "相同文件已导入，返回已有任务。" },
        { status: 200 }
      );
    }
    if (!rule) return NextResponse.json({ error: "请选择有效的解析规则。" }, { status: 400 });

    const task = await createImportTaskFast({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      fileBytes: bytes,
      fileHash: hash,
      rule,
      estimatedRows: estimateRowCount(file.name, bytes)
    });

    const serverlessFallbackMaxRows = Number(process.env.SERVERLESS_IMPORT_MAX_ROWS || 2_000);
    const runServerlessFallback =
      process.env.VERCEL === "1" &&
      process.env.SERVERLESS_IMPORT_FALLBACK !== "false" &&
      task.total_rows <= serverlessFallbackMaxRows;

    after(async () => {
      try {
        await persistImportFile(task.task_id, file.type || "application/octet-stream", bytes);
        if (runServerlessFallback) await processImportTaskInBackground(task.task_id);
      } catch (error) {
        console.error("[import-file-persist] failed", error);
      }
    });

    return NextResponse.json({ ...task, upload_duration_ms: Math.round(performance.now() - started) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "异步任务创建失败。" }, { status: 500 });
  }
}
