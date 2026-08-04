import { NextResponse } from "next/server";
import { getImportTask, listImportErrors } from "@/lib/import-repository";

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function GET(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  try {
    if (!(await getImportTask(taskId))) return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    const result = await listImportErrors(taskId, { page: 1, pageSize: 100, code: undefined, batch: undefined });
    const header = ["unit_id", "batch_index", "row_number", "field_name", "raw_value", "error_code", "error_reason"];
    const lines = [header, ...result.items.map((item) => [item.unit_id, item.batch_index, item.row_number, item.field_name, item.raw_value, item.error_code, item.error_reason])]
      .map((row) => row.map(csvCell).join(","));
    return new NextResponse(`\uFEFF${lines.join("\n")}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${taskId}-errors.csv"`
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "错误导出失败。" }, { status: 503 });
  }
}
