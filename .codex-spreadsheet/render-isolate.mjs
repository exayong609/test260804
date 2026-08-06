import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const mode = process.argv[2];
let workbook;
let sheetName;
if (mode === "new") {
  workbook = Workbook.create();
  sheetName = "Probe";
  workbook.worksheets.add(sheetName).getRange("A1").values = [["OK"]];
} else {
  const input = await FileBlob.load("../submission/\u8003\u8bd5\u63d0\u4ea4\u6c47\u603b\u8868.xlsx");
  workbook = await SpreadsheetFile.importXlsx(input);
  sheetName = "\u8003\u8bd5\u63d0\u4ea4\u6c47\u603b";
  if (mode === "no-table") {
    for (const table of [...workbook.worksheets.getItem(sheetName).tables.items]) table.delete();
  }
}
const preview = await workbook.render({ sheetName, range: "A1:A1", scale: 1, format: "png" });
await fs.writeFile(`isolate-${mode}.png`, new Uint8Array(await preview.arrayBuffer()));
console.log(`RENDERED ${mode}`);
