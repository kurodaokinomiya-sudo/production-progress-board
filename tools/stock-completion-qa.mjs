import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runBrowserQa, selectQaView } from "./browser-runtime.mjs";

const jobId = "QA-MIXED-SHIPMENT";
const savedJob = page => page.evaluate(id => api.read().jobs.find(job => job.id === id), jobId);
const stockState = page => page.evaluate(() => api.getFinishedStock());

async function openProcess(page) {
  await selectQaView(page, "completed");
  await page.locator(`[data-action="open-process"][data-order-id="${jobId}"][data-stage-key="shipping"]`).first().click();
  await page.locator("#process-dialog").waitFor({ state: "visible" });
}

async function lifecycleSave(page, { rejected = false } = {}) {
  await page.locator("#process-lifecycle-action").click();
  await page.locator("#process-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(({ id, rejected }) => !pendingProcessSaves.has(id) && (!rejected || failedProcessDrafts.has(id)), { id: jobId, rejected });
}

async function setup(page, { stock = 0, shipped = 0, replenishment = false } = {}) {
  await page.evaluate(async ({ stock, shipped, replenishment, id }) => {
    finishedStockUi.clear(); failedProcessDrafts.clear(); document.querySelector("#toast-stack").replaceChildren();
    const data = api.read(); data.jobs = []; data.finishedStockEvents = []; api.write(data);
    let job = await api.saveJob({ id, requestId: "qa-register", customer: "合成受注", product: "Tezoe スタンツェ 直・上向", productCode: "26001", quantity: replenishment ? 10 : 3, stockPlannedQuantity: replenishment ? 5 : 0, serialNo: "QA-MIXED", dueDate: todayIso(), stages: { finish: { status: "working", assignee: "豊" } } });
    if (stock) await api.openFinishedStock({ requestId: "qa-opening", expectedVersion: 0, productId: "26001", quantity: stock, date: todayIso(), note: "合成在庫" });
    if (!replenishment) await api.saveFinishedStockSchedule({ requestId: "qa-schedule", expectedVersion: (await api.getFinishedStock()).version, jobId: id, jobVersion: job.version, orderQuantity: 5, stockQuantity: 2, shipmentMode: "split", shipDate: todayIso() });
    const sent = await api.savePolishingMovement({ action: "send", requestId: "qa-polish-send", date: todayIso(), items: [{ id, version: job.version, quantity: job.quantity }] });
    const returned = await api.savePolishingMovement({ action: "return", requestId: "qa-polish-return", date: todayIso(), items: [{ id, version: sent.jobs[0].version, quantity: job.quantity }] });
    job = returned.jobs[0];
    job = await api.saveJob({ ...job, requestId: "qa-finish", stages: { ...job.stages, finish: { status: "done", assignee: "豊" } } });
    if (shipped) await api.shipFinishedStock({ requestId: "qa-ship", expectedVersion: (await api.getFinishedStock()).version, productId: "26001", orderJobId: id, jobVersion: job.version, quantity: shipped, date: todayIso(), purpose: "sale" });
    await refreshData(); await finishedStockUi.refresh();
  }, { stock, shipped, replenishment, id: jobId });
}

await runBrowserQa("stock-completion", async ({ page, output, label }) => {
  await selectQaView(page, "finishedStock");
  const evidence = [];
  for (const fixture of [{ stock: 0, shipped: 0 }, { stock: 1, shipped: 1 }, { stock: 2, shipped: 0 }]) {
    await setup(page, fixture);
    await selectQaView(page, "finishedStock");
    const row = page.locator(`[data-stock-order="${jobId}"]`);
    assert.ok((await row.textContent()).includes(`出荷予定残 ${2 - fixture.shipped}丁`));
    await page.setViewportSize({ width: 375, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (!fixture.stock) {
      await row.locator("td").nth(3).evaluate(element => element.scrollIntoView({ block: "center", inline: "center" }));
      await page.screenshot({ path: path.join(output, `${label}-unallocated-stock-demand-mobile.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await openProcess(page); await lifecycleSave(page, { rejected: true });
    assert.notEqual((await savedJob(page)).shippingStatus, "shipped");
    assert.ok((await page.locator("#toast-stack").textContent()).includes("在庫からの出荷予定分が残っています"));
    const stock = await stockState(page);
    assert.equal(stock.orders.find(order => order.jobId === jobId).stockTargetQuantity, 2 - fixture.shipped);
    assert.equal(stock.products.find(product => product.id === "26001").stockQuantity, fixture.stock - fixture.shipped);
    evidence.push({ ...fixture, completionRejected: true, pendingStockShipment: 2 - fixture.shipped });
  }

  await setup(page, { stock: 2, shipped: 2 });
  const before = await stockState(page);
  await openProcess(page); await lifecycleSave(page);
  assert.equal((await savedJob(page)).shippingStatus, "shipped");
  assert.equal((await stockState(page)).version, before.version);
  await openProcess(page); await lifecycleSave(page);
  assert.notEqual((await savedJob(page)).shippingStatus, "shipped");
  assert.equal((await stockState(page)).products.find(product => product.id === "26001").stockQuantity, 0);
  evidence.push({ stock: 2, shipped: 2, completionSucceeded: true, reopened: true, noExtraStockMovement: true });

  await setup(page, { replenishment: true });
  await openProcess(page); await lifecycleSave(page);
  let stock = await stockState(page);
  assert.equal((await savedJob(page)).shippingStatus, "shipped");
  assert.equal(stock.orders.some(order => order.jobId === jobId), false);
  assert.equal(stock.plans.find(plan => plan.jobId === jobId).quantity, 5);
  await selectQaView(page, "finishedStock");
  const receive = page.locator(`[data-stock-action="receive"][data-job-id="${jobId}"]`);
  await receive.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await receive.click();
  await page.locator('#finished-stock-form [name="quantity"]').fill("5");
  await page.locator("#finished-stock-submit").click();
  await page.locator("#finished-stock-dialog").waitFor({ state: "hidden" });
  stock = await stockState(page);
  assert.equal(stock.products.find(product => product.id === "26001").stockQuantity, 5);
  assert.equal(stock.lots.find(lot => lot.jobId === jobId).quantity, 5);
  evidence.push({ manufactured: 10, customerQuantity: 5, replenishment: 5, completionBeforeReceipt: true, receiptAfterCompletion: true });
  await writeFile(path.join(output, `${label}-stock-completion-evidence.json`), JSON.stringify(evidence, null, 2));
});
