import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

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
  const hashStarted = performance.now();
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const hashMs = performance.now() - hashStarted;

  const uploadStarted = performance.now();
  const response = await fetch(`${baseUrl}/api/import-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: path.basename(filePath),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSize: bytes.byteLength,
      fileHash: fingerprint,
      estimatedRows: 0,
      ruleId
    })
  });
  const taskCreateMs = performance.now() - uploadStarted;
  if (response.status >= 500) serverErrors += 1;
  const created = await response.json() as { task_id?: string; trace_id?: string; duplicated?: boolean; error?: string };
  if (!response.ok || !created.task_id) throw new Error(created.error || `上传失败：HTTP ${response.status}`);
  console.log(`task_id=${created.task_id} trace_id=${created.trace_id} task_ready=${(hashMs + taskCreateMs).toFixed(0)}ms`);

  let fileUploadMs = 0;
  if (!created.duplicated) {
    const form = new FormData();
    form.set("file", new File([bytes], path.basename(filePath), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    form.set("fileHash", fingerprint);
    const fileUploadStarted = performance.now();
    const fileResponse = await fetch(`${baseUrl}/api/import-tasks/${created.task_id}/file`, { method: "POST", body: form });
    fileUploadMs = performance.now() - fileUploadStarted;
    if (fileResponse.status >= 500) serverErrors += 1;
    const fileBody = await fileResponse.json() as { uploaded?: boolean; error?: string };
    if (!fileResponse.ok || !fileBody.uploaded) throw new Error(fileBody.error || `文件上传失败：HTTP ${fileResponse.status}`);
  }

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
  const taskReadyMs = hashMs + taskCreateMs;
  const passed = !created.duplicated && taskReadyMs <= 1_000 && totalMs <= 60_000 && final.status !== "failed" && serverErrors === 0;
  const report = {
    tested_at: new Date().toISOString(),
    app_url: baseUrl,
    file: filePath,
    sku_master_rows: 20_000,
    upload_ms: Math.round(taskReadyMs),
    task_create_ms: Math.round(taskCreateMs),
    client_hash_ms: Math.round(hashMs),
    file_transfer_ms: Math.round(fileUploadMs),
    duplicate_short_circuit: Boolean(created.duplicated),
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
