import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const range = process.argv[2] || "A1:H2";
const input = await FileBlob.load("../submission/\u8003\u8bd5\u63d0\u4ea4\u6c47\u603b\u8868.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
const preview = await workbook.render({
  sheetName: "\u8003\u8bd5\u63d0\u4ea4\u6c47\u603b",
  range,
  scale: 1,
  format: "png",
});
await fs.writeFile(`probe-${range.replace(":", "-")}.png`, new Uint8Array(await preview.arrayBuffer()));
console.log(`RENDERED ${range}`);
