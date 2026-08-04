import assert from "node:assert/strict";
import test from "node:test";
import { toImportErrorRecord } from "../src/lib/import-types";

test("maps import errors to the snake_case database record", () => {
  assert.deepEqual(
    toImportErrorRecord(
      {
        taskId: "task_1",
        unitId: "unit_0001",
        batchIndex: 1,
        rowNumber: 12,
        fieldName: "skuCode",
        rawValue: "SKU_00001",
        errorCode: "E001",
        errorReason: "SKU not found",
        traceId: "trace_1"
      },
      "redacted"
    ),
    {
      task_id: "task_1",
      unit_id: "unit_0001",
      batch_index: 1,
      row_number: 12,
      field_name: "skuCode",
      raw_value: "redacted",
      error_code: "E001",
      error_reason: "SKU not found",
      trace_id: "trace_1"
    }
  );
});
