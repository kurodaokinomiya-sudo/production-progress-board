import assert from "node:assert/strict";
import path from "node:path";
import { runBrowserQa, selectQaView, waitForQaReady } from "./browser-runtime.mjs";

await runBrowserQa("smoke", async ({ page, output, label }) => {
  assert.equal(await page.locator('[data-view-panel="orders"]').isVisible(), true);
  for (const view of ["dashboard", "completed", "distribution", "polishing", "materials", "finishedStock", "intake", "settings", "orders"]) {
    await selectQaView(page, view);
  }
  await page.locator('[data-action="new-order"]').first().click();
  const form = page.locator("#order-form");
  await form.locator('[name="customer"]').fill("回帰QA");
  await form.locator('[name="product"]').fill("鋭匙鉗子 21cm 直 4mm");
  await form.locator('[name="quantity"]').fill("3");
  await form.locator('[name="serialNo"]').fill("QA-SMOKE");
  await form.locator('[name="note"]').fill("合成データ 保存と再読込");
  await form.getByRole("button", { name: "注文情報を保存", exact: true }).click();
  await page.locator("#order-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.some(job => job.serialNo === "QA-SMOKE"));
  await page.reload(); await waitForQaReady(page);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find(job => job.serialNo === "QA-SMOKE"));
  assert.equal(saved.note, "合成データ 保存と再読込");
  await page.locator(`[data-action="open-process"][data-order-id="${saved.id}"][data-stage-key="welding"]`).first().click();
  const row = page.locator('#process-form .stage-edit-row[data-stage-key="welding"]');
  await row.locator('[data-status="working"]').click();
  await row.locator('[data-assignee="豊"]').click();
  await page.locator("#process-form").getByRole("button", { name: "工程を保存", exact: true }).click();
  await page.locator("#process-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(id => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find(job => job.id === id)?.stages.welding.assignee === "豊", saved.id);
  await page.reload(); await waitForQaReady(page);
  const reloaded = await page.evaluate(id => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find(job => job.id === id), saved.id);
  assert.equal(reloaded.stages.welding.status, "working");
  assert.equal(reloaded.stages.welding.assignee, "豊");
  assert.equal(reloaded.note, saved.note);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: path.join(output, `${label}-tablet.png`), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
