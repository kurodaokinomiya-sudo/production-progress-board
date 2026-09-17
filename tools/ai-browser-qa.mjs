import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kurom/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const baseUrl = process.env.PROGRESS_BOARD_QA_URL || "http://127.0.0.1:4174";
const output = path.resolve("output/playwright");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let sent = 0;
let mode = "success";
let diagnosticMode = "connection-failure";
const diagnosticCalls = [];
await page.route("**/api/local/diagnose-ai", (route) => {
  const payload = route.request().postDataJSON();
  assert.deepEqual(Object.keys(payload), ["step"]);
  diagnosticCalls.push(payload.step);
  if (diagnosticMode === "connection-failure" || (diagnosticMode === "format-failure" && payload.step === "format")) return route.fulfill({ status: 400, json: { error: "HTTP 400: Request contains an invalid argument." } });
  return route.fulfill({ json: { step: payload.step, accepted: true, outputValid: true, model: "gemini-3.1-flash-lite" } });
});
await page.route(/https:\/\/(?:fonts\.|generativelanguage\.)/, (route) => route.fulfill({ status: 200, body: "" }));
await page.route("**/api/local/ai-status", (route) => route.fulfill({ json: { ready: true, configured: true, model: "gemini-3.1-flash-lite" } }));
await page.route("**/api/local/parse-order-ai", async (route) => {
  sent++;
  const payload = route.request().postDataJSON();
  assert.equal(payload.mimeType, "application/pdf");
  assert.ok(payload.base64);
  if (mode === "failure") return route.fulfill({ status: 400, json: { error: "AI取込を停止しました（HTTP 400／診断: UNKNOWN・INVALID_ARGUMENT）。候補は登録していません。\nGoogle応答（機密値は伏せています）: Request contains an invalid argument.\ngeneration_config.max_output_tokens: Value exceeds allowed limit. <script>not executable</script>" } });
  return route.fulfill({ json: { engineVersion: 2, engine: "ai", text: "原本を確認してください", results: [{ itemNumber: 1, confidence: 0, parsed: {
    customer: "AI動作検証用", product: "彫骨器 18cm 3mm", quantity: "", dueDate: "2026-11-30", specLength: "18cm", bladeWidth: "3mm", category: "ケリソンパンチ",
    _ai: { page: 1, row: "1", evidence: "数量欄は判読不能", warnings: ["数量を原本で確認"] }
  } }] } });
});
try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("[data-action='open-import']").first().click();
  assert.equal(await page.locator("#import-engine").inputValue(), "ai");
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 1024 });
    const dimensions = await page.locator("#import-dialog").evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth, overflowing: [...el.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > el.getBoundingClientRect().right).map((child) => child.id || child.className).slice(0, 12) }));
    assert.ok(dimensions.scroll <= dimensions.client, JSON.stringify(dimensions));
    await page.screenshot({ path: path.join(output, `ai-import-${width}.png`), fullPage: true });
  }
  await page.locator("#image-input").setInputFiles({ name: "架空の検証資料.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nSynthetic QA only") });
  await page.locator("[data-action='upload-image']").click();
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  assert.equal(sent, 1);
  const card = page.locator(".intake-card").filter({ hasText: "架空の検証資料" });
  assert.equal(await card.getByText("AI・要確認", { exact: true }).count(), 1);
  await card.getByRole("button", { name: "内容を確認する" }).click();
  assert.match(await page.locator("#intake-source-preview").textContent(), /数量欄は判読不能/);
  const quantity = page.locator("#intake-form [name='quantity']");
  assert.equal(await quantity.inputValue(), "");
  assert.equal(await quantity.evaluate((el) => el.checkValidity()), false);
  await quantity.fill("3");
  await page.locator("#intake-form button[type='submit']").click();
  await page.locator("#intake-dialog").waitFor({ state: "hidden" });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find((job) => job.customer === "AI動作検証用"));
  assert.equal(saved.quantity, 3);
  assert.equal(saved.labelPrintStatus, "waiting");
  mode = "failure";
  await page.locator("[data-action='open-import']").first().click();
  await page.locator("#image-input").setInputFiles({ name: "上限確認.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nSynthetic QA only") });
  await page.locator("[data-action='upload-image']").click();
  await page.locator("#file-import-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#file-import-error").textContent(), /診断: UNKNOWN・INVALID_ARGUMENT/);
  assert.match(await page.locator("#file-import-error").textContent(), /Request contains an invalid argument/);
  assert.equal(await page.locator("#file-import-error script").count(), 0);
  assert.equal(sent, 2);
  assert.equal(await page.locator("#import-dialog").evaluate((el) => el.open), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).intake.filter((item) => item.status === "pending").length), 0);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 1024 });
    await page.locator("#file-import-error").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#file-import-error").evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: path.join(output, `ai-error-${width}.png`), fullPage: true });
  }
  await page.locator("#image-input").setInputFiles({ name: "別の資料.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nSynthetic QA only") });
  assert.equal(await page.locator("#file-import-error").isVisible(), false);
  await page.getByText("AIで読み取れないとき", { exact: true }).click();
  const diagnose = page.locator("[data-action='diagnose-ai']");
  await diagnose.click();
  await page.getByText(/1\. 最小限の通信: 停止/).waitFor();
  assert.deepEqual(diagnosticCalls, ["connection"]);
  diagnosticMode = "format-failure";
  await diagnose.click();
  await page.getByText(/2\. アプリの回答形式: 停止/).waitFor({ timeout: 20000 });
  assert.deepEqual(diagnosticCalls, ["connection", "connection", "format"]);
  diagnosticMode = "success";
  await diagnose.click();
  await page.getByText(/固定テスト文の読取も成功/).waitFor({ timeout: 20000 });
  assert.deepEqual(diagnosticCalls, ["connection", "connection", "format", "connection", "format"]);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).intake.filter((item) => item.status === "pending").length), 0);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 1024 });
    await page.locator("#ai-diagnostic-result").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#ai-diagnostic-result").evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: path.join(output, `ai-diagnostic-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("AI UI QA PASS: mocked response only; raw PDF route, review, required quantity, label queue, persistent HTTP400 diagnosis, file-change reset, 320/768/1280px. No real AI inference executed.");
} finally { await browser.close(); }
