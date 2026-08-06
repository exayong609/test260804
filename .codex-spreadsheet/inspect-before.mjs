import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("../submission/考试提交汇总表.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
console.log((await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 12000, tableMaxRows: 30, tableMaxCols: 12 })).ndjson);
for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange();
  console.log(`SHEET=${sheet.name}`);
  console.log((await workbook.inspect({ kind: "table", sheetId: sheet.name, range: used.address, include: "values,formulas", tableMaxRows: 40, tableMaxCols: 15, maxChars: 12000 })).ndjson);
  console.log((await workbook.inspect({ kind: "computedStyle", sheetId: sheet.name, range: used.address, maxChars: 5000 })).ndjson);
  const png = await workbook.render({ sheetName: sheet.name, autoCrop: "all", scale: 2, format: "png" });
  await fs.writeFile(`before-${sheet.name}.png`, new Uint8Array(await png.arrayBuffer()));
}
