import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
const input = await FileBlob.load("../submission/考试提交汇总表.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
const png = await workbook.render({ sheetName: "考试提交汇总", range: "A1:H2", scale: 1, format: "png" });
await fs.writeFile("C:/Users/ZTO_LLY/Documents/ai_test/07/v2-source/.codex-spreadsheet/final.png", new Uint8Array(await png.arrayBuffer()));
console.log("rendered");
