import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, qaBaseUrl } from "./browser-runtime.mjs";

const output = path.resolve("output/polishing");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
const storedJobs = () => page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs);
async function view(name) {
  const button = page.locator(`[data-view="${name}"]`);
  if (!await button.isVisible()) await page.locator("[data-action='toggle-nav']").click();
  await button.click();
  await page.locator(`[data-view-panel="${name}"]`).waitFor({ state: "visible" });
}
async function send(id) {
  await page.locator(`[data-view-panel="orders"] [data-action="open-polishing-send"][data-order-id="${id}"]`).click();
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find((job) => job.id === id).polishing?.sentQuantity > 0, id);
  await page.waitForFunction(() => ![...document.querySelectorAll(".polishing-send-button")].some((button) => button.disabled));
}
try {
  await page.goto(await qaBaseUrl("/src/index.html"), { waitUntil: "domcontentloaded" });
  await page.locator("#orders-workspace .ledger-viewport").waitFor();
  const before = await storedJobs();
  await send("DEMO-001");
  await send("DEMO-002");
  await page.locator('[data-view-panel="orders"] [data-order-id="DEMO-001"] [data-stage-key="finish"]').click();
  assert.equal(await page.locator("#process-stage-finish").innerText(), "最終仕上げ");
  assert.equal(await page.locator('#process-form [data-stage-key="finish"] [data-status="done"]:enabled').count(), 0, "全数戻り前は最終仕上げの完了操作を提供しない");
  await page.locator('[data-action="close-process-dialog"]').first().click();
  await view("polishing");
  await page.locator('[data-polishing-select-id="DEMO-001"]').check();
  await page.locator('[data-polishing-select-id="DEMO-002"]').check();
  assert.match(await page.locator("#polishing-selection-summary").innerText(), /2件.*21丁/);
  assert.equal(await page.locator("#polishing-workspace input[type='number']").count(), 0);
  await page.waitForFunction(() => document.querySelector("#toast-stack").childElementCount === 0);
  await page.screenshot({ path: path.join(output, "desktop-selected-returns.png"), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(output, "tablet-selected-returns.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator("#polishing-return-button").click();
  await page.waitForFunction(() => ["DEMO-001", "DEMO-002"].every(id => {
    const job = JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find(job => job.id === id);
    return job.polishing.returnedQuantity === job.polishing.sentQuantity;
  }));
  const returnedJobs = await storedJobs();
  for (const [id, sent, returned] of [["DEMO-001", 10, 10], ["DEMO-002", 11, 11]]) {
    const job = returnedJobs.find((entry) => entry.id === id);
    assert.equal(job.polishing.sentQuantity, sent);
    assert.equal(job.polishing.returnedQuantity, returned);
    for (const key of ["customer", "product", "quantity", "serialNo", "labelPrintStatus", "labelPrintedAt"]) assert.equal(job[key], before.find((entry) => entry.id === id)[key]);
  }
  assert.match(await page.locator("#polishing-totals").innerText(), /21/);
  await page.locator("#polishing-filter").selectOption("finishing");
  assert.equal(await page.locator("[data-polishing-row]").count(), 2);
  await page.locator('[data-polishing-row="DEMO-001"] [data-action="open-process"]').click();
  for (const key of ["welding", "base", "grinding", "heat", "finish"]) await page.locator(`[data-stage-key="${key}"] [data-status="done"]`).click();
  await page.locator("#process-form button[type='submit']").click();
  await page.locator("#process-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find((job) => job.id === "DEMO-001").stages.finish.status === "done");
  assert.equal(await page.locator("[data-polishing-row]").count(), 1);
  await view("orders");
  await send("DEMO-004");
  await page.locator('[data-view-panel="orders"] [data-action="show-polishing-order"][data-order-id="DEMO-004"]').click();
  await page.locator('[data-polishing-row="DEMO-004"] .polishing-history summary').click();
  await page.locator('[data-action="cancel-polishing-send"][data-order-id="DEMO-004"]').click();
  assert.equal(await page.locator("#polishing-form input[type='number']").count(), 0);
  await page.locator("#polishing-submit-button").click();
  await page.locator("#polishing-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find(job => job.id === "DEMO-004").polishing.sentQuantity === 0);
  assert.equal((await storedJobs()).find((job) => job.id === "DEMO-004").polishing.sentQuantity, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", oneClickSend: true, wholeJobBulkReturn: true, noQuantityEntry: true, finishGuard: true, finalFinish: true, cancel: true, tablet: true, labelMetadataPreserved: true, screenshots: output }));
} finally {
  await browser.close();
}
