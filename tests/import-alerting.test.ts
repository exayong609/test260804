import assert from "node:assert/strict";
import test from "node:test";
import { buildDingTalkAlertBody, notifyImportAlert } from "../src/lib/import-alerting";

const alert = {
  title: "SKU 校验进入降级",
  severity: "warning" as const,
  taskId: "task-1",
  traceId: "trace-1",
  unitId: "unit-1",
  message: "查询超时",
  metadata: { batch_index: 2 }
};

test("builds a DingTalk-compatible markdown alert", () => {
  const body = buildDingTalkAlertBody(alert);
  assert.equal(body.msgtype, "markdown");
  assert.match(body.markdown.text, /task-1/);
  assert.match(body.markdown.text, /trace-1/);
  assert.match(body.markdown.text, /batch_index/);
});

test("skips alert delivery when no webhook is configured", async () => {
  const previous = process.env.IMPORT_ALERT_WEBHOOK_URL;
  delete process.env.IMPORT_ALERT_WEBHOOK_URL;
  try {
    assert.deepEqual(await notifyImportAlert(alert), { sent: false, reason: "not-configured" });
  } finally {
    if (previous === undefined) delete process.env.IMPORT_ALERT_WEBHOOK_URL;
    else process.env.IMPORT_ALERT_WEBHOOK_URL = previous;
  }
});

test("delivers the alert to the configured webhook", async () => {
  const previousUrl = process.env.IMPORT_ALERT_WEBHOOK_URL;
  const previousFetch = globalThis.fetch;
  process.env.IMPORT_ALERT_WEBHOOK_URL = "https://example.test/webhook";
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, "POST");
    assert.match(String(init?.body), /SKU 校验进入降级/);
    return new Response("ok", { status: 200 });
  };
  try {
    assert.deepEqual(await notifyImportAlert(alert), { sent: true });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.IMPORT_ALERT_WEBHOOK_URL;
    else process.env.IMPORT_ALERT_WEBHOOK_URL = previousUrl;
  }
});
