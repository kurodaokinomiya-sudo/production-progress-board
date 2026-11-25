import assert from "node:assert/strict";
import path from "node:path";
import { runBrowserQa, selectQaView, waitForQaReady } from "./browser-runtime.mjs";

await runBrowserQa("material-exclusions", async ({ page, output, label }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const input = { customer: "材料対象外確認用", product: "Tezoe 材料確認用 26099", productCode: "26099", specShape: "直・上向", specLength: "18cm", bladeWidth: "3mm", quantity: 4, serialNo: "QA-MATERIAL-1" };
  await page.evaluate(async (order) => { await api.saveJob({ ...order, requestId: "qa-material-order-1" }); }, input);
  await selectQaView(page, "materials");
  const row = page.locator("#material-unresolved-list .material-unresolved-row").filter({ hasText: input.product });
  await row.waitFor({ state: "visible" });
  const before = await page.evaluate(async () => {
    const inventory = await api.getMaterialInventory();
    return { quantities: inventory.materials.map((material) => material.stockQuantity), history: inventory.history };
  });
  const button = row.getByRole("button", { name: "碓井材料を使わない", exact: true });
  const dialog = page.locator("#material-dialog");
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px page overflow`);
    const bounds = await button.boundingBox();
    assert.ok(bounds.width >= 44 && bounds.height >= 44, `${width}px touch target`);
    await button.click();
    await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.innerText(), /Tezoe 材料確認用 26099/);
    await page.screenshot({ path: path.join(output, `${label}-${width}-dialog.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px dialog overflow`);
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  }
  await button.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "使わない製品として登録", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await row.waitFor({ state: "hidden" });
  await page.locator("#material-exclusions summary").click();
  await page.locator("#material-exclusions-list").getByText(input.product, { exact: true }).waitFor();
  await page.evaluate(async (order) => { await api.saveJob({ ...order, quantity: 6, serialNo: "QA-MATERIAL-2", requestId: "qa-material-order-2" }); }, input);
  await page.reload();
  await waitForQaReady(page);
  await selectQaView(page, "materials");
  await page.getByText("碓井材料在庫を更新しました。", { exact: true }).waitFor();
  assert.equal(await page.locator("#material-unresolved-list").getByText(input.product, { exact: true }).count(), 0);
  const excluded = page.locator("#material-exclusions");
  await excluded.locator("summary").click();
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  assert.equal(await excluded.getByRole("button", { name: `${input.product}の登録を取り消す`, exact: true }).isEnabled(), true);
  await page.screenshot({ path: path.join(output, `${label}-dark-registered.png`) });
  await excluded.getByRole("button", { name: `${input.product}の登録を取り消す`, exact: true }).click();
  await dialog.getByRole("button", { name: "登録を取り消す", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator("#material-unresolved-list").getByText(input.product, { exact: true }).count(), 2);
  const after = await page.evaluate(async () => {
    const inventory = await api.getMaterialInventory();
    return { quantities: inventory.materials.map((material) => material.stockQuantity), history: inventory.history };
  });
  assert.deepEqual(after, before, "registration and revocation preserve inventory and history");
});
