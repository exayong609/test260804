import { after, NextResponse } from "next/server";
import { createOrReuseImportTaskFast, listImportTasks, persistImportFileAndActivate } from "@/lib/import-repository";
import { estimateRowCount, fileHash } from "@/lib/import-upload";
import { getRuleById } from "@/lib/store";
import type { ParsingRule } from "@/types";
import { parseImportTaskInit, shouldUseServerlessFallback } from "@/lib/import-task-init";

export const runtime = "nodejs";
export const maxDuration = 60;

const SUPPORTED_FILE = /\.(xlsx|xls|docx|pdf)$/i;

async function resolveRule(ruleId: string, ruleValue: unknown) {
  if (ruleValue && typeof ruleValue === "object") return ruleValue as ParsingRule;
  if (typeof ruleValue === "string" && ruleValue) return JSON.parse(ruleValue) as ParsingRule;
  return ruleId ? await getRuleById(ruleId) : null;
}

function shouldRunServerlessFallback(fileSize: number) {
  const maxBytes = Number(process.env.SERVERLESS_IMPORT_MAX_BYTES || 512_000);
  return shouldUseServerlessFallback({
    isVercel: process.env.VERCEL === "1",
    disabled: process.env.SERVERLESS_IMPORT_FALLBACK === "false",
    fileSize,
    maxBytes
  });
}

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
    if (request.headers.get("content-type")?.includes("application/json")) {
      const parsed = parseImportTaskInit(await request.json());
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      const body = parsed.value;
      const rule = await resolveRule(body.ruleId, body.rule);
      if (!rule) return NextResponse.json({ error: "请选择有效的解析规则。" }, { status: 400 });

      const result = await createOrReuseImportTaskFast({
        fileName: body.fileName,
        mimeType: body.mimeType,
        fileHash: body.fileHash,
        rule,
        estimatedRows: body.estimatedRows
      });
      return NextResponse.json({
        ...result.task,
        duplicated: result.duplicated,
        file_upload_pending: !result.filePersisted,
        notice: result.filePersisted ? "相同文件已导入，返回已有任务。" : undefined,
        upload_duration_ms: Math.round(performance.now() - started)
      }, { status: result.duplicated ? 200 : 202 });
    }

    const form = await request.formData();
    const file = form.get("file");
    const ruleId = String(form.get("ruleId") || "");
    const ruleRaw = form.get("rule");
    if (!(file instanceof File)) return NextResponse.json({ error: "请上传文件。" }, { status: 400 });
    if (!SUPPORTED_FILE.test(file.name)) {
      return NextResponse.json({ error: "仅支持 xlsx、xls、docx 和 pdf 文件。" }, { status: 400 });
    }

    const rule = await resolveRule(ruleId, ruleRaw);
    if (!rule) return NextResponse.json({ error: "请选择有效的解析规则。" }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = fileHash(bytes);

    const result = await createOrReuseImportTaskFast({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      fileHash: hash,
      rule,
      estimatedRows: estimateRowCount(file.name, bytes)
    });
    if (result.duplicated && result.filePersisted) {
      return NextResponse.json(
        {
          ...result.task,
          duplicated: true,
          file_upload_pending: !result.filePersisted,
          notice: result.filePersisted ? "相同文件已导入，返回已有任务。" : "已找到待上传任务，继续上传文件。",
          upload_duration_ms: Math.round(performance.now() - started)
        },
        { status: 200 }
      );
    }

    const task = result.task;
    const runServerlessFallback = shouldRunServerlessFallback(bytes.byteLength);

    after(async () => {
      try {
        await persistImportFileAndActivate(
          task.task_id,
          file.type || "application/octet-stream",
          bytes,
          hash,
          { delivery: runServerlessFallback ? "serverless" : "queue" }
        );
        if (runServerlessFallback) {
          const { processImportTaskInBackground } = await import("@/lib/serverless-import-fallback");
          await processImportTaskInBackground(task.task_id);
        }
      } catch (error) {
        console.error("[import-file-persist] failed", error);
      }
    });

    return NextResponse.json({
      ...task,
      duplicated: result.duplicated,
      file_upload_pending: false,
      upload_duration_ms: Math.round(performance.now() - started)
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "异步任务创建失败。" }, { status: 500 });
  }
}
