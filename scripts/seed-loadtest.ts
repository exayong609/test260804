import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { ensureImportSchema } from "../src/lib/import-schema";
import { getSql } from "../src/lib/store";

async function main() {
  const root = process.cwd();
  const targetDir = path.join(root, "test-data");
  await fs.mkdir(targetDir, { recursive: true });

  const skus = Array.from({ length: 20_000 }, (_, index) => {
    const no = index + 1;
    return {
      sku_code: `SKU_${String(no).padStart(5, "0")}`,
      name: `压测商品${no}`,
      spec: `${(no % 5) + 1}kg/标准装`,
      unit: "件"
    };
  });

  const orders = Array.from({ length: 10_000 }, (_, index) => {
    const no = index + 1;
    const skuNo = ((no * 37) % 20_000) + 1;
    return {
      外部编码: `LOAD_20260804_${String(no).padStart(5, "0")}`,
      门店名称: `压测门店${(no % 100) + 1}`,
      收货人: `测试收件人${no}`,
      收货电话: `13${String(800_000_000 + (no % 99_999_999)).padStart(9, "0")}`.slice(0, 11),
      收货地址: `上海市浦东新区压测路${no}号`,
      商品编码: no % 333 === 0 ? `SKU_INVALID_${String(no).padStart(5, "0")}` : `SKU_${String(skuNo).padStart(5, "0")}`,
      商品名称: `压测商品${skuNo}`,
      数量: no % 999 === 0 ? -1 : (no % 8) + 1,
      规格: `${(skuNo % 5) + 1}kg/标准装`,
      备注: no % 777 === 0 ? "故意注入异常数据" : ""
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(orders);
  worksheet["!cols"] = [
    { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 15 }, { wch: 30 },
    { wch: 22 }, { wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 22 }
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "订单明细");
  XLSX.writeFile(workbook, path.join(targetDir, "10000-orders.xlsx"), { compression: true });
  await fs.writeFile(
    path.join(targetDir, "sku-master-20000.csv"),
    ["sku_code,name,spec,unit", ...skus.map((sku) => `${sku.sku_code},${sku.name},${sku.spec},${sku.unit}`)].join("\n"),
    "utf8"
  );

  if (process.env.DATABASE_URL) {
    await ensureImportSchema();
    const sql = getSql();
    if (!sql) throw new Error("DATABASE_URL 无效。");
    await sql.begin(async (tx) => {
      await tx`truncate table sku_master restart identity`;
      for (let index = 0; index < skus.length; index += 1_000) {
        const chunk = skus.slice(index, index + 1_000);
        await tx`
          insert into sku_master (sku_code, name, spec, unit)
          select x.sku_code, x.name, x.spec, x.unit
          from jsonb_to_recordset(${tx.json(chunk)}::jsonb)
            as x(sku_code text, name text, spec text, unit text)
          on conflict (sku_code) do update set name = excluded.name, spec = excluded.spec, unit = excluded.unit
        `;
      }
    });
    console.log("PostgreSQL 已灌入 20,000 条 SKU 主数据。");
  } else {
    console.log("未配置 DATABASE_URL，仅生成压测文件和 SKU CSV。");
  }
  console.log(`Excel: ${path.join(targetDir, "10000-orders.xlsx")}`);
  console.log(`SKU CSV: ${path.join(targetDir, "sku-master-20000.csv")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
