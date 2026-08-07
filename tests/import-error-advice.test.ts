import assert from "node:assert/strict";
import test from "node:test";
import { errorAdvice, fillMinuteGaps } from "../src/lib/import-error-advice";

test("maps error codes to actionable advice", () => {
  assert.match(errorAdvice("E001"), /SKU 主数据/);
  assert.match(errorAdvice("E005"), /重复导入/);
  assert.match(errorAdvice("W001"), /降级/);
  assert.match(errorAdvice("E999"), /重试失败批次/);
});

test("fills minute gaps with zeros and keeps chronological order", () => {
  const now = new Date("2026-08-06T06:30:45.000Z");
  const series = fillMinuteGaps([{ minute: "2026-08-06T06:29", rows: 4200 }], 5, now);
  assert.deepEqual(
    series.map((point) => point.minute),
    ["2026-08-06T06:26", "2026-08-06T06:27", "2026-08-06T06:28", "2026-08-06T06:29", "2026-08-06T06:30"]
  );
  assert.deepEqual(series.map((point) => point.rows), [0, 0, 0, 4200, 0]);
});
