import assert from "node:assert/strict";
import test from "node:test";
import { MAX_IMPORT_FILE_BYTES, parseImportTaskInit, shouldUseServerlessFallback } from "../src/lib/import-task-init";

const valid = {
  fileName: "orders.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileSize: 1_500_000,
  fileHash: "a".repeat(64),
  estimatedRows: 10_000,
  ruleId: "template_tabular_summary"
};

test("accepts a valid task-init payload", () => {
  const result = parseImportTaskInit(valid);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.estimatedRows, 10_000);
});

test("rejects unsupported files before task creation", () => {
  assert.deepEqual(parseImportTaskInit({ ...valid, fileName: "orders.exe" }), { ok: false, error: "仅支持 xlsx、xls、docx 和 pdf 文件。" });
});

test("rejects invalid SHA-256 fingerprints", () => {
  const result = parseImportTaskInit({ ...valid, fileHash: "not-a-hash" });
  assert.equal(result.ok, false);
});

test("rejects empty and oversized uploads", () => {
  assert.equal(parseImportTaskInit({ ...valid, fileSize: 0 }).ok, false);
  assert.equal(parseImportTaskInit({ ...valid, fileSize: MAX_IMPORT_FILE_BYTES + 1 }).ok, false);
});

test("clamps untrusted estimated row counts", () => {
  const result = parseImportTaskInit({ ...valid, estimatedRows: 9_000_000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.estimatedRows, 2_000_000);
});

test("normalizes non-finite estimated row counts", () => {
  const result = parseImportTaskInit({ ...valid, estimatedRows: "not-a-number" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.estimatedRows, 0);
});

test("uses serverless fallback only for small Vercel uploads", () => {
  assert.equal(shouldUseServerlessFallback({ isVercel: true, disabled: false, fileSize: 100_000 }), true);
  assert.equal(shouldUseServerlessFallback({ isVercel: true, disabled: false, fileSize: 1_500_000 }), false);
  assert.equal(shouldUseServerlessFallback({ isVercel: true, disabled: true, fileSize: 100_000 }), false);
});
