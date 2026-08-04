import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { estimateRowCount, fileHash } from "../src/lib/import-upload";

test("estimates Excel data rows without executing the rule engine", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["商品编码", "数量"], ["SKU_00001", 2], ["SKU_00002", 3]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "订单明细");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  assert.equal(estimateRowCount("orders.xlsx", bytes), 2);
});

test("file hash is stable for idempotency and duplicate upload detection", () => {
  const bytes = new TextEncoder().encode("same-file");
  assert.equal(fileHash(bytes), fileHash(bytes));
  assert.notEqual(fileHash(bytes), fileHash(new TextEncoder().encode("other-file")));
});
