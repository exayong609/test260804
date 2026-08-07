export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

export type ImportTaskInitRequest = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileHash: string;
  estimatedRows: number;
  ruleId: string;
  rule?: unknown;
};

export function parseImportTaskInit(value: unknown): { ok: true; value: ImportTaskInitRequest } | { ok: false; error: string } {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fileName = String(input.fileName || "").trim();
  const fileHash = String(input.fileHash || "").toLowerCase();
  const fileSize = Number(input.fileSize || 0);
  const estimatedRowsInput = Number(input.estimatedRows || 0);
  if (!/\.(xlsx|xls|docx|pdf)$/i.test(fileName)) return { ok: false, error: "仅支持 xlsx、xls、docx 和 pdf 文件。" };
  if (!/^[0-9a-f]{64}$/.test(fileHash)) return { ok: false, error: "文件指纹格式无效。" };
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_IMPORT_FILE_BYTES) {
    return { ok: false, error: "文件大小无效或超过 20MB。" };
  }
  return {
    ok: true,
    value: {
      fileName,
      mimeType: String(input.mimeType || "application/octet-stream"),
      fileSize,
      fileHash,
      estimatedRows: Number.isFinite(estimatedRowsInput)
        ? Math.max(0, Math.min(Math.floor(estimatedRowsInput), 2_000_000))
        : 0,
      ruleId: String(input.ruleId || ""),
      rule: input.rule
    }
  };
}

export function shouldUseServerlessFallback(options: {
  isVercel: boolean;
  disabled: boolean;
  fileSize: number;
  maxBytes?: number;
}) {
  return options.isVercel && !options.disabled && options.fileSize <= (options.maxBytes ?? 512_000);
}
