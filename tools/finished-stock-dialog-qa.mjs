import assert from "node:assert/strict";
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
