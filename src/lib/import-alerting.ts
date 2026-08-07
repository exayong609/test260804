export type ImportAlertSeverity = "warning" | "error";

export type ImportAlertInput = {
  title: string;
  severity: ImportAlertSeverity;
  taskId: string;
  traceId: string;
  unitId?: string;
  message: string;
  metadata?: Record<string, string | number | boolean>;
};

export function buildDingTalkAlertBody(input: ImportAlertInput) {
  const severityLabel = input.severity === "error" ? "错误" : "警告";
  const details = [
    `- 级别：${severityLabel}`,
    `- 任务：${input.taskId}`,
    `- Trace：${input.traceId}`,
    input.unitId ? `- 处理单元：${input.unitId}` : null,
    `- 说明：${input.message}`,
    input.metadata ? `- 指标：${JSON.stringify(input.metadata)}` : null
  ].filter(Boolean);

  return {
    msgtype: "markdown",
    markdown: {
      title: input.title,
      text: `### ${input.title}\n${details.join("\n")}`
    }
  };
}

export async function notifyImportAlert(input: ImportAlertInput) {
  const webhookUrl = process.env.IMPORT_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return { sent: false, reason: "not-configured" } as const;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDingTalkAlertBody(input)),
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { sent: true } as const;
  } catch (error) {
    console.error(`[import-alert] ${input.title}: ${error instanceof Error ? error.message : String(error)}`);
    return { sent: false, reason: "delivery-failed" } as const;
  }
}
