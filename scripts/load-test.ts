import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const baseUrl = process.env.APP_URL || "http://127.0.0.1:3000";
  const filePath = process.env.LOAD_TEST_FILE || path.join(process.cwd(), "test-data", "10000-orders.xlsx");
  const ruleResponse = await fetch(`${baseUrl}/api/rules`);
  const ruleBody = await ruleResponse.json() as { rules?: Array<{ id: string; name: string }>; error?: string };
  if (!ruleResponse.ok) throw new Error(ruleBody.error || `规则查询失败：HTTP ${ruleResponse.status}`);
  const ruleId = process.env.RULE_ID || ruleBody.rules?.find((rule) => /标准|汇总明细/.test(rule.name))?.id || ruleBody.rules?.[0]?.id;
  if (!ruleId) throw new Error("没有可用于压测的解析规则。");

  const bytes = await fs.readFile(filePath);
  const samples: number[] = [];
  let serverErrors = 0;
  const startedAt = performance.now();
  const form = new FormData();
  form.set("file", new File([bytes], path.basename(filePath), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  form.set("ruleId", ruleId);

  const uploadStarted = performance.now();
  const response = await fetch(`${baseUrl}/api/import-tasks`, { method: "POST", body: form });
  samples.push(performance.now() - uploadStarted);
  if (response.status >= 500) serverErrors += 1;
  const created = await response.json() as { task_id?: string; trace_id?: string; error?: string };
  if (!response.ok || !created.task_id) throw new Error(created.error || `上传失败：HTTP ${response.status}`);
  console.log(`task_id=${created.task_id} trace_id=${created.trace_id} upload=${samples[0].toFixed(0)}ms`);

  let final: Record<string, unknown> = created;
  while (!['completed', 'partial_success', 'failed'].includes(String(final.status || ''))) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const pollStarted = performance.now();
    const poll = await fetch(`${baseUrl}/api/import-tasks/${created.task_id}`, { cache: "no-store" });
    samples.push(performance.now() - pollStarted);
    if (poll.status >= 500) serverErrors += 1;
    final = await poll.json() as Record<string, unknown>;
    if (!poll.ok) throw new Error(String(final.error || `进度查询失败：HTTP ${poll.status}`));
    console.log(`${final.status} ${final.processed_rows}/${final.total_rows} failed=${final.failed_rows}`);
  }

  const totalMs = performance.now() - startedAt;
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] || 0;
  const passed = samples[0] <= 1_000 && totalMs <= 60_000 && final.status !== "failed" && serverErrors === 0;
  const report = {
    tested_at: new Date().toISOString(),
    app_url: baseUrl,
    file: filePath,
    sku_master_rows: 20_000,
    upload_ms: Math.round(samples[0]),
    request_p95_ms: Math.round(p95),
    total_ms: Math.round(totalMs),
    server_errors: serverErrors,
    final,
    target_passed: passed
  };
  await fs.mkdir(path.join(process.cwd(), "reports"), { recursive: true });
  await fs.writeFile(path.join(process.cwd(), "reports", "load-test-result.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
