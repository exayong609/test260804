const ADVICE: Record<string, string> = {
  E001: "核对商品编码是否存在于 SKU 主数据；若为新商品请先维护主数据后重试失败批次。",
  E002: "补齐必填字段（外部编码、SKU 编码等）后重新导入。",
  E003: "修正收货电话为 11 位手机号格式后重新导入。",
  E004: "数量必须为正数，修正源文件后重新导入。",
  E005: "该外部编码已入库，属重复导入；如需更新请确认后删除历史记录或更换外部编码。",
  E006: "字段映射失败，检查并调整解析规则后重新导入。",
  E007: "数据库写入失败，可点击“重试失败批次”重新入队。",
  E008: "文件格式不支持，请转换为 xlsx、xls、docx 或 pdf。",
  W001: "本行在 SKU 校验降级期间未经过主数据校验，服务恢复后建议复核。"
};

export function errorAdvice(errorCode: string): string {
  return ADVICE[errorCode] ?? "查看错误原因并修正源数据后重试失败批次。";
}

export type MinutePoint = { minute: string; rows: number };

export function fillMinuteGaps(points: MinutePoint[], minutes = 5, now: Date = new Date()): MinutePoint[] {
  const byMinute = new Map(points.map((point) => [point.minute.slice(0, 16), point.rows]));
  const result: MinutePoint[] = [];
  const cursor = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  cursor.setMinutes(cursor.getMinutes() - (minutes - 1));
  for (let index = 0; index < minutes; index += 1) {
    const key = cursor.toISOString().slice(0, 16);
    result.push({ minute: key, rows: byMinute.get(key) ?? 0 });
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return result;
}
