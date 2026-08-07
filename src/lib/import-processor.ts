import { performance } from "node:perf_hooks";
import { notifyImportAlert } from "@/lib/import-alerting";
import { parseUploadToDocument } from "@/lib/document";
import {
  claimBatch,
  completeBatch,
  failBatch,
  failTask,
  findExistingExternalCodes,
  findValidSkuCodes,
  getParsedTaskLookup,
  loadBatchRows,
  persistParsedRows,
  recordInsertDuration
} from "@/lib/import-repository";
import type { ImportBatchPayload, ImportErrorInput } from "@/lib/import-types";
import { executeRule } from "@/lib/rule-engine";
import { groupRows, validateRows } from "@/lib/validation";
import type { OrderField, ParsedOrderRow, ValidationIssue } from "@/types";

function issueCode(issue: ValidationIssue) {
  if (/重复/.test(issue.message)) return "E005";
  if (/电话/.test(issue.message)) return "E003";
  if (/数量|正数/.test(issue.message)) return "E004";
  if (/必填|缺少|不能为空/.test(issue.message)) return "E002";
  return "E006";
}

function rawValue(row: ParsedOrderRow | undefined, field?: OrderField | "order") {
  if (!row || !field || field === "order") return "";
  return String(row[field] ?? "");
}

function validationError(taskId: string, unitId: string, batchIndex: number, traceId: string, rows: ParsedOrderRow[], issue: ValidationIssue): ImportErrorInput {
  const row = issue.rowId
    ? rows.find((item) => item.id === issue.rowId)
    : issue.rowNumber
      ? rows.find((item) => item.rowNumber === issue.rowNumber)
      : undefined;
  return {
    taskId,
    unitId,
    batchIndex,
    rowNumber: row?.rowNumber ?? issue.rowNumber ?? 0,
    fieldName: issue.field ?? "order",
    rawValue: rawValue(row, issue.field),
    errorCode: issueCode(issue),
    errorReason: issue.message,
    traceId
  };
}

export class ImportFileNotReadyError extends Error {
  constructor(taskId: string) {
    super(`导入任务 ${taskId} 的原始文件尚未持久化，等待重试。`);
    this.name = "ImportFileNotReadyError";
  }
}

export async function processImportTask(taskId: string) {
  const lookup = await getParsedTaskLookup(taskId);
  if (lookup.kind === "missing") return { skipped: true, reason: "task-missing" };
  if (lookup.kind === "file-pending") throw new ImportFileNotReadyError(taskId);
  const payload = lookup.payload;
  try {
    const parseStarted = performance.now();
    const fileBytes = Uint8Array.from(payload.fileBytes);
    const file = new File([fileBytes.buffer], payload.fileName, { type: payload.mimeType });
    const document = await parseUploadToDocument(file);
    const parseDurationMs = Math.round(performance.now() - parseStarted);
    const ruleStarted = performance.now();
    const result = executeRule(document, payload.rule, []);
    const ruleDurationMs = Math.round(performance.now() - ruleStarted);
    await persistParsedRows(payload.taskId, payload.traceId, result.rows, parseDurationMs, ruleDurationMs);
    return { rows: result.rows.length, parseDurationMs, ruleDurationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(payload.taskId, payload.traceId, message);
    throw error;
  }
}

export async function processImportBatch(payload: ImportBatchPayload) {
  const claimed = await claimBatch(payload.task_id, payload.unit_id);
  if (!claimed) return { skipped: true, reason: "already-processed-or-locked" };
  const started = performance.now();
  try {
    const rows = await loadBatchRows(payload.task_id, claimed.start_row, claimed.end_row);
    const validateStarted = performance.now();
    const [{ codes: validSkuCodes, degraded }, existingCodes] = await Promise.all([
      findValidSkuCodes(rows.map((row) => row.skuCode)),
      findExistingExternalCodes(rows.map((row) => row.externalCode || ""))
    ]);

    const errors = validateRows(rows, existingCodes)
      .filter((issue) => issue.severity === "error")
      .map((issue) => validationError(payload.task_id, payload.unit_id, claimed.batch_index, payload.trace_id, rows, issue));

    if (!degraded) {
      for (const row of rows) {
        if (!validSkuCodes.has(row.skuCode)) {
          errors.push({
            taskId: payload.task_id,
            unitId: payload.unit_id,
            batchIndex: claimed.batch_index,
            rowNumber: row.rowNumber,
            fieldName: "skuCode",
            rawValue: row.skuCode,
            errorCode: "E001",
            errorReason: "SKU 不存在于商品主数据",
            traceId: payload.trace_id
          });
        }
      }
    } else {
      for (const row of rows) {
        errors.push({
          taskId: payload.task_id,
          unitId: payload.unit_id,
          batchIndex: claimed.batch_index,
          rowNumber: row.rowNumber,
          fieldName: "skuCode",
          rawValue: row.skuCode,
          errorCode: "W001",
          errorReason: "SKU 主数据查询超时，本行未经过完整商品校验",
          traceId: payload.trace_id
        });
      }
    }

    const uniqueErrors = [...new Map(errors.map((error) => [
      `${error.rowNumber}:${error.fieldName}:${error.errorCode}`,
      error
    ])).values()];
    const invalidRows = new Set(uniqueErrors.filter((error) => !error.errorCode.startsWith("W")).map((error) => error.rowNumber));
    const validRows = rows.filter((row) => !invalidRows.has(row.rowNumber));
    const validateDurationMs = Math.round(performance.now() - validateStarted);
    const writeStarted = performance.now();
    const result = await completeBatch({
      taskId: payload.task_id,
      traceId: payload.trace_id,
      unitId: payload.unit_id,
      batchIndex: claimed.batch_index,
      sourceRowCount: rows.length,
      groups: groupRows(validRows),
      errors: uniqueErrors,
      degraded,
      performance: {
        taskId: payload.task_id,
        unitId: payload.unit_id,
        batchIndex: claimed.batch_index,
        parseDurationMs: payload.parse_duration_ms ?? 0,
        ruleDurationMs: payload.rule_duration_ms ?? 0,
        validateDurationMs,
        insertDurationMs: 0,
        totalDurationMs: Math.round(performance.now() - started),
        status: "completed",
        traceId: payload.trace_id
      }
    });
    const insertDurationMs = Math.round(performance.now() - writeStarted);
    const totalDurationMs = Math.round(performance.now() - started);
    if (result.applied) await recordInsertDuration(payload.task_id, payload.unit_id, insertDurationMs, totalDurationMs);
    if (degraded) {
      await notifyImportAlert({
        title: "SKU 校验进入降级",
        severity: "warning",
        taskId: payload.task_id,
        traceId: payload.trace_id,
        unitId: payload.unit_id,
        message: `第 ${claimed.batch_index} 批 SKU 主数据查询超时，已记录 W001 并继续处理。`,
        metadata: { batch_index: claimed.batch_index, source_rows: rows.length, total_duration_ms: totalDurationMs }
      });
    }
    return { ...result, degraded, insertDurationMs, totalDurationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failBatch(payload.task_id, payload.unit_id, payload.trace_id, message);
    throw error;
  }
}
