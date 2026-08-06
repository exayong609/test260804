import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
const input = await FileBlob.load("../submission/考试提交汇总表.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
const out = await SpreadsheetFile.exportXlsx(workbook);
await out.save("C:/Users/ZTO_LLY/Documents/ai_test/07/v2-source/original-export.xlsx");
console.log("ok");
