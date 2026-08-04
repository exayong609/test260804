import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export function fileHash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function estimateRowCount(fileName: string, bytes: Uint8Array) {
  if (!/\.xlsx?$/i.test(fileName)) return 0;
  const workbook = XLSX.read(bytes, { type: "array", dense: true, sheetRows: 20_000 });
  return workbook.SheetNames.reduce((total, name) => {
    const reference = workbook.Sheets[name]?.["!ref"];
    if (!reference) return total;
    const range = XLSX.utils.decode_range(reference);
    return total + Math.max(0, range.e.r - range.s.r);
  }, 0);
}
