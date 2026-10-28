import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runBrowserQa, selectQaView } from "./browser-runtime.mjs";

const dialogSelector = "#finished-stock-dialog";
const openSelector = '[data-stock-action="opening"]';
async function open(page) {
  await page.locator(openSelector).first().click();
  await page.locator(dialogSelector).waitFor({ state: "visible" });
}
async function close(page, method) {
  if (method === "button") await page.locator(`${dialogSelector} [data-stock-close]`).first().click();
  else if (method === "escape") await page.keyboard.press("Escape");
  else await page.mouse.click(4, 4);
  await page.locator(dialogSelector).waitFor({ state: "hidden" });
  await page.waitForFunction(() => ![...document.querySelectorAll("body > header, body > main, body > footer")].some(element => element.inert));
}
async function fill(page, note, quantity = "5") {
  await page.locator('#finished-stock-form [name="quantity"]').fill(quantity);
  await page.locator('#finished-stock-form [name="note"]').fill(note);
}
async function resetDraft(page) {
  await page.evaluate(async () => { finishedStockUi.clear(); await finishedStockUi.refresh(); });
}
const events = page => page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).finishedStockEvents || []);

async function shipmentRetries(page, output, label) {
  const evidence = [];
  const originalData = await page.evaluate(() => api.read());
  for (const mode of ["remaining-order", "fully-shipped-order", "failure-before-write", "no-stock-left"]) {
    const fixture = await page.evaluate(async mode => {
      finishedStockUi.clear();
      const data = api.read(); data.jobs = []; data.finishedStockEvents = []; api.write(data);
      const quantity = ["fully-shipped-order", "no-stock-left"].includes(mode) ? 2 : 5;
      const job = await api.saveJob({ id: "QA-STOCK-RETRY", requestId: `register-${mode}`, customer: "合成出荷先", product: "Tezoe スタンツェ 直・上向", productCode: "26001", quantity, stockPlannedQuantity: 0, serialNo: "QA-RETRY", note: "合成再試行", dueDate: todayIso() });
      for (const [lotNo, quantity] of [["QA-LOT-A", 2], ["QA-LOT-B", 5]]) {
        if (mode === "no-stock-left" && lotNo === "QA-LOT-B") continue;
        await api.mutateFinishedStock("opening", { requestId: lotNo, expectedVersion: (await api.getFinishedStock()).version, productId: "26001", quantity, date: todayIso(), lotNo, note: "合成在庫" });
      }
      await api.saveFinishedStockSchedule({ requestId: "schedule-retry", expectedVersion: (await api.getFinishedStock()).version, jobId: job.id, jobVersion: job.version, orderQuantity: quantity, stockQuantity: quantity, shipmentMode: "split", shipDate: todayIso() });
      const snapshot = await api.getFinishedStock();
      globalThis.qaShipWrites = [];
      globalThis.qaOriginalShip = api.shipFinishedStock.bind(api);
      let fail = true;
      api.shipFinishedStock = async payload => {
        qaShipWrites.push(structuredClone(payload));
        if (fail && mode === "failure-before-write") { fail = false; throw new Error("synthetic failure before write"); }
        const result = await qaOriginalShip(payload);
        if (fail) { fail = false; throw new Error("synthetic lost shipment reply"); }
        return result;
      };
      await refreshData(); await finishedStockUi.refresh();
      return { jobId: job.id, lotId: snapshot.lots.find(lot => lot.lotNo === "QA-LOT-A").id };
    }, mode);
    await page.locator(`[data-stock-order="${fixture.jobId}"] [data-stock-action="ship"]`).click();
    await page.locator('#finished-stock-form [name="lotId"]').selectOption(fixture.lotId);
    await page.locator('#finished-stock-form [name="quantity"]').fill("2");
    await page.locator("#finished-stock-submit").click();
    await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "false" && document.querySelector("#finished-stock-form-status").textContent.includes("入力を保持"));
    if (mode !== "failure-before-write") await page.evaluate(async id => {
      const job = api.read().jobs.find(job => job.id === id);
      await api.saveJob({ ...job, requestId: "change-after-ship", note: "保存応答消失後の別更新" });
      await refreshData(); await finishedStockUi.refresh();
    }, fixture.jobId);
    await close(page, "escape");
    await page.locator('[data-stock-product="26001"] [data-stock-action="ship"]').click();
    assert.equal(await page.locator('#finished-stock-form [name="lotId"]').inputValue(), fixture.lotId);
    assert.equal(await page.locator('#finished-stock-form [name="orderJobId"]').inputValue(), fixture.jobId);
    assert.equal(await page.locator('#finished-stock-form [name="quantity"]').inputValue(), "2");
    await page.setViewportSize({ width: 375, height: 900 });
    assert.ok(await page.locator(dialogSelector).evaluate(element => element.scrollWidth <= element.clientWidth));
    if (mode === "remaining-order") await page.screenshot({ path: path.join(output, `${label}-shipment-retry-mobile.png`), fullPage: true });
    await page.locator("#finished-stock-submit").click();
    await page.locator(dialogSelector).waitFor({ state: "hidden" });
    const result = await page.evaluate(async () => ({ snapshot: await api.getFinishedStock(), writes: qaShipWrites }));
    const shipments = result.snapshot.history.filter(event => event.action === "ship");
    assert.equal(shipments.length, 1);
    assert.equal(shipments.reduce((sum, event) => sum + event.quantity, 0), 2);
    const remainingStock = mode === "no-stock-left" ? 0 : 5;
    assert.equal(result.snapshot.products.find(product => product.id === "26001").stockQuantity, remainingStock);
    assert.equal(result.writes[0].requestId, result.writes[1].requestId);
    assert.equal(result.writes[0].jobVersion, result.writes[1].jobVersion);
    evidence.push({ mode, shipmentEvents: shipments.length, shippedQuantity: 2, remainingStock, sameRequestId: true, sameJobVersion: true });
    if (mode === "remaining-order") {
      await page.locator(`[data-stock-order="${fixture.jobId}"] [data-stock-action="ship"]`).click();
      await page.locator('#finished-stock-form [name="quantity"]').fill("1");
      await page.locator("#finished-stock-submit").click();
      await page.locator(dialogSelector).waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => qaShipWrites[2].requestId !== qaShipWrites[0].requestId), true);
      assert.equal((await events(page)).filter(event => event.action === "ship").length, 2);
    }
    await page.evaluate(() => { api.shipFinishedStock = qaOriginalShip; });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.evaluate(async data => { api.write(data); finishedStockUi.clear(); await refreshData(); await finishedStockUi.refresh(); }, originalData);
  await writeFile(path.join(output, `${label}-shipment-retry-evidence.json`), JSON.stringify(evidence, null, 2));
}

await runBrowserQa("stock-dialog", async ({ page, output, label }) => {
  await selectQaView(page, "finishedStock");
  for (const method of ["button", "backdrop", "escape"]) {
    await resetDraft(page); await open(page); await close(page, method);
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), openSelector);
    await open(page); await fill(page, `合成下書き-${method}`); await close(page, method); await open(page);
    assert.equal(await page.locator('#finished-stock-form [name="quantity"]').inputValue(), "5");
    assert.equal(await page.locator('#finished-stock-form [name="note"]').inputValue(), `合成下書き-${method}`);
    await close(page, method);
  }

  await page.evaluate(() => {
    globalThis.qaStockWrites = [];
    globalThis.qaStockGate = new Promise(resolve => { globalThis.qaStockRelease = resolve; });
    const original = api.openFinishedStock.bind(api);
    api.openFinishedStock = async payload => {
      qaStockWrites.push(structuredClone(payload)); await qaStockGate;
      const result = await original(payload);
      if (globalThis.qaStockLoseReply) { globalThis.qaStockLoseReply = false; throw new Error("synthetic lost stock reply"); }
      return result;
    };
  });
  await resetDraft(page); await open(page); await fill(page, "遅い保存の合成fixture");
  await page.locator("#finished-stock-submit").click();
  await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "true");
  const closeButton = page.locator(`${dialogSelector} [data-stock-close]`).first();
  assert.equal(await closeButton.isDisabled(), true);
  await closeButton.evaluate(element => element.click());
  await page.mouse.click(4, 4); await page.keyboard.press("Escape");
  assert.equal(await page.locator(dialogSelector).isVisible(), true);
  assert.equal(await page.evaluate(() => qaStockWrites.length), 1);
  await page.evaluate(() => qaStockRelease());
  await page.locator(dialogSelector).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "false");
  assert.equal((await events(page)).length, 1);
  await page.waitForFunction(() => !document.querySelector("body > main").inert && document.activeElement !== document.body);

  for (const method of ["button", "backdrop", "escape"]) {
    const before = (await events(page)).length;
    await open(page); await fill(page, `応答消失-${method}`);
    await page.evaluate(() => { globalThis.qaStockLoseReply = true; });
    await page.locator("#finished-stock-submit").click();
    await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "false" && document.querySelector("#finished-stock-form-status").textContent.includes("入力を保持"));
    await close(page, method); await open(page);
    assert.equal(await page.locator('#finished-stock-form [name="note"]').inputValue(), `応答消失-${method}`);
    await page.locator("#finished-stock-submit").click();
    await page.locator(dialogSelector).waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "false");
    const stored = await events(page);
    assert.equal(stored.length, before + 1);
    assert.equal(await page.evaluate(() => qaStockWrites.at(-1).requestId === qaStockWrites.at(-2).requestId), true);
  }

  await shipmentRetries(page, output, label);

  await open(page); await fill(page, "失効時に消す下書き", "2");
  await page.evaluate(() => { globalThis.qaStockGate = new Promise(resolve => { globalThis.qaStockRelease = resolve; }); });
  await page.locator("#finished-stock-submit").click();
  await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "true");
  await page.evaluate(() => handleAccessRequired());
  await page.locator(dialogSelector).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement.id === "access-required" && !document.querySelector("body > main").inert);
  await page.evaluate(() => qaStockRelease());
  await page.waitForFunction(() => document.querySelector("#finished-stock-form").getAttribute("aria-busy") === "false");
  await page.evaluate(async () => {
    state.accessRevoked = false; document.body.classList.remove("access-locked");
    document.querySelector("#access-required").hidden = true;
    await refreshData(); switchView("finishedStock"); await finishedStockUi.refresh();
  });
  await open(page);
  assert.equal(await page.locator('#finished-stock-form [name="quantity"]').inputValue(), "");
  assert.equal(await page.locator('#finished-stock-form [name="note"]').inputValue(), "");
  await fill(page, "再表示とキーボード操作の合成fixture");
  await page.setViewportSize({ width: 768, height: 1024 }); await page.keyboard.press("Tab");
  assert.equal(await page.locator(dialogSelector).evaluate(element => element.contains(document.activeElement)), true);
  await page.screenshot({ path: path.join(output, `${label}-stock-dialog-tablet.png`), fullPage: true });
  await close(page, "escape"); await open(page);
  assert.equal(await page.locator('#finished-stock-form [name="note"]').inputValue(), "再表示とキーボード操作の合成fixture");
  await close(page, "button");
});
