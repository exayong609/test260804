import type { ParsedOrderRow, ParsingRule } from "@/types";

export type ImportTaskStatus = "pending" | "processing" | "completed" | "partial_success" | "failed";
export type ImportUnitStatus = "pending" | "processing" | "completed" | "failed";

export type ImportTaskCreateInput = {
  fileName: string;
  mimeType: string;
  fileBytes: Uint8Array;
  fileHash: string;
  rule: ParsingRule;
  estimatedRows: number;
};

export type ImportTaskInitInput = Omit<ImportTaskCreateInput, "fileBytes">;

export type ImportTaskSnapshot = {
  task_id: string;
  trace_id: string;
  file_name: string;
  status: ImportTaskStatus;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  degraded: boolean;
  created_at: string;
  completed_at?: string;
};

export type OutboxRecord = {
  id: string;
  aggregate_id: string;
  event_type: "ImportTaskCreated" | "ImportBatchCreated";
  payload: Record<string, unknown>;
  trace_id: string;
  retry_count: number;
};

export type ParsedTaskPayload = {
  taskId: string;
  traceId: string;
  fileName: string;
  mimeType: string;
  fileBytes: Uint8Array;
  rule: ParsingRule;
};

export type ParsedTaskLookup =
  | { kind: "ready"; payload: ParsedTaskPayload }
  | { kind: "file-pending"; taskId: string; traceId: string }
  | { kind: "missing" };

export type ImportBatchPayload = {
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  trace_id: string;
  parse_duration_ms?: number;
  rule_duration_ms?: number;
};

export type ImportRowRecord = {
  taskId: string;
  unitId: string;
  rowNumber: number;
  payload: ParsedOrderRow;
};

export type ImportErrorInput = {
  taskId: string;
  unitId: string;
  batchIndex: number;
  rowNumber: number;
  fieldName: string;
  rawValue: string;
  errorCode: string;
  errorReason: string;
  traceId: string;
};

export function toImportErrorRecord(input: ImportErrorInput, rawValue: string) {
  return {
    task_id: input.taskId,
    unit_id: input.unitId,
    batch_index: input.batchIndex,
    row_number: input.rowNumber,
    field_name: input.fieldName,
    raw_value: rawValue,
    error_code: input.errorCode,
    error_reason: input.errorReason,
    trace_id: input.traceId
  };
}

export type BatchPerformanceInput = {
  taskId: string;
  unitId: string;
  batchIndex: number;
  parseDurationMs: number;
  ruleDurationMs: number;
  validateDurationMs: number;
  insertDurationMs: number;
  totalDurationMs: number;
  status: ImportUnitStatus;
  traceId: string;
};
