import { after, NextResponse } from "next/server";
import { fileHash } from "@/lib/import-upload";
import { persistImportFileAndActivate } from "@/lib/import-repository";
import { processImportTaskInBackground } from "@/lib/serverless-import-fallback";
import { MAX_IMPORT_FILE_BYTES, shouldUseServerlessFallback } from "@/lib/import-task-init";

export const runtime = "nodejs";
export const maxDuration = 60;

const TASK_ID = /^task_[0-9a-f-]{36}$/i;

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  if (!TASK_ID.test(taskId)) return NextResponse.json({ error: "非法 task_id。" }, { status: 400 });

  try {
    const form = await request.formData();
    const file = form.get("file");
    const expectedHash = String(form.get("fileHash") || "").toLowerCase();
    if (!(file instanceof File)) return NextResponse.json({ error: "请上传文件。" }, { status: 400 });
    if (file.size <= 0 || file.size > MAX_IMPORT_FILE_BYTES) {
      return NextResponse.json({ error: "文件大小无效或超过 20MB。" }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const actualHash = fileHash(bytes);
    if (expectedHash && expectedHash !== actualHash) {
      return NextResponse.json({ error: "文件传输后指纹校验失败。" }, { status: 409 });
    }

    const maxFallbackBytes = Number(process.env.SERVERLESS_IMPORT_MAX_BYTES || 512_000);
    const runServerlessFallback = shouldUseServerlessFallback({
      isVercel: process.env.VERCEL === "1",
      disabled: process.env.SERVERLESS_IMPORT_FALLBACK === "false",
      fileSize: bytes.byteLength,
      maxBytes: maxFallbackBytes
    });
    await persistImportFileAndActivate(
      taskId,
      file.type || "application/octet-stream",
      bytes,
      actualHash,
      { delivery: runServerlessFallback ? "serverless" : "queue" }
    );
    if (runServerlessFallback) {
      after(async () => {
        try {
          await processImportTaskInBackground(taskId);
        } catch (error) {
          console.error("[serverless-import-fallback] failed", error);
        }
      });
    }

    return NextResponse.json({ task_id: taskId, uploaded: true, file_hash: actualHash, size_bytes: bytes.byteLength });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "文件上传失败。" }, { status: 500 });
  }
}
