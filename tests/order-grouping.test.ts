import assert from "node:assert/strict";
import test from "node:test";
import { groupRows } from "../src/lib/validation";
import type { ParsedOrderRow } from "../src/types";

function row(id: string, overrides: Partial<ParsedOrderRow>): ParsedOrderRow {
  return {
    id,
    rowNumber: Number(id.replace(/\D/g, "")) || 1,
    skuCode: `SKU-${id}`,
    skuName: `商品-${id}`,
    skuQuantity: 1,
    ...overrides
  };
}

test("groups multi-sheet rows by destination when no external code exists", () => {
  const groups = groupRows([
    row("1", { storeName: "银泰店" }),
    row("2", { storeName: "银泰店" }),
    row("3", { storeName: "金桥店" })
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.skuLines.length), [2, 1]);
});

test("separates the same external code when destinations differ", () => {
  const groups = groupRows([
    row("1", { externalCode: "DB-001", storeName: "银泰店" }),
    row("2", { externalCode: "DB-001", storeName: "金桥店" })
  ]);

  assert.equal(groups.length, 2);
});
