import assert from "node:assert/strict";
import path from "node:path";
import { runBrowserQa, selectQaView, waitForQaReady } from "./browser-runtime.mjs";

function rowBackground(row) {
  return row.evaluate(async (element) => {
    await Promise.all(element.getAnimations()
      .filter((animation) => animation.transitionProperty === "background-color")
      .map((animation) => animation.finished));
    const color = getComputedStyle(element).backgroundColor;
    return color === "rgba(0, 0, 0, 0)" ? getComputedStyle(element.closest("table")).backgroundColor : color;
  });
}

async function checkRowHighlights(page, rows, label) {
  const ordinary = rows.nth(0);
  const striped = rows.nth(1);
  await striped.waitFor();
  await page.mouse.move(0, 0);
  assert.notEqual(await rowBackground(ordinary), await rowBackground(striped), `${label}: alternating backgrounds`);

  for (const row of [ordinary, striped]) {
    const resting = await rowBackground(row);
    await row.hover();
    const highlighted = await rowBackground(row);
    assert.notEqual(highlighted, resting, `${label}: pointer highlights the row`);
    await page.mouse.move(0, 0);
    assert.equal(await rowBackground(row), resting, `${label}: pointer leaves the row`);

    const firstButton = row.getByRole("button").first();
    await firstButton.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.equal(await firstButton.evaluate((button) => button.matches(":focus-visible")), true);
    assert.equal(await rowBackground(row), highlighted, `${label}: keyboard highlights the row`);
    await page.locator('[data-view="settings"]').focus();
  }
}

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

  for (const theme of ["dark", "light"]) {
    await selectQaView(page, "settings");
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    await selectQaView(page, "castingStock");
    await checkRowHighlights(page, page.locator("#casting-stock-rows tr[data-casting-part]"), `casting / ${theme}`);
    await selectQaView(page, "orders");
    await checkRowHighlights(page, page.locator("#orders-workspace .order-table tbody").first().locator("tr[data-order-id]"), `orders / ${theme}`);
  }

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: path.join(output, `${label}-tablet.png`), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
