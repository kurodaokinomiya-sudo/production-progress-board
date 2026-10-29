import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runBrowserQa, selectQaView, waitForQaReady } from "./browser-runtime.mjs";

await runBrowserQa("product-inference", async ({ page, output, label }) => {
  await page.evaluate(async () => {
    const data = api.read(); data.jobs = []; data.intake = []; data.finishedStockEvents = []; api.write(data);
    await refreshData();
  });
  const evidence = [];
  const cases = [
    { product: "鋭匙鉗子 弱弯・上向", shape: "弱弯・上向", serial: "N04-MANUAL-1" },
    { product: "鋭匙鉗子　全長１８０ｍｍ 強彎／下向 刃幅３．５ｍｍ", shape: "強弯・下向", serial: "N04-MANUAL-2", length: "180mm", width: "3.5mm" },
    { product: "鋭匙鉗子 弱弯・上向", shape: "弱弯", serial: "N04-EXPLICIT", explicit: true },
  ];
  for (const fixture of cases) {
    await page.locator('[data-action="new-order"]').first().click();
    const form = page.locator("#order-form");
    await form.locator('[name="customer"]').fill("N04合成注文");
    await form.locator('[name="product"]').fill(fixture.product);
    await form.locator('[name="quantity"]').fill("3");
    assert.equal(await form.locator('[name="specShape"]').inputValue(), fixture.explicit ? "弱弯・上向" : fixture.shape);
    if (fixture.explicit) {
      await form.locator('[name="specShape"]').fill(fixture.shape);
      await form.locator('[name="specLength"]').fill("21cm");
      await form.locator('[name="bladeWidth"]').fill("4mm");
    }
    await form.locator('[name="serialNo"]').fill(fixture.serial);
    if (fixture.length) {
      assert.equal(await form.locator('[name="specLength"]').inputValue(), fixture.length);
      assert.equal(await form.locator('[name="bladeWidth"]').inputValue(), fixture.width);
      await page.setViewportSize({ width: 375, height: 900 });
      await form.locator('[name="specShape"]').focus();
      assert.ok(await page.locator("#order-dialog").evaluate(element => element.scrollWidth <= element.clientWidth));
      await page.screenshot({ path: path.join(output, `${label}-direction-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await form.getByRole("button", { name: "注文情報を保存", exact: true }).click();
    await page.locator("#order-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(serial => api.read().jobs.some(job => job.serialNo === serial), fixture.serial);
    await page.reload(); await waitForQaReady(page);
    const saved = await page.evaluate(serial => api.read().jobs.find(job => job.serialNo === serial), fixture.serial);
    assert.equal(saved.specShape, fixture.shape);
    assert.equal(saved.quantity, 3);
    if (fixture.explicit) {
      assert.equal(saved.specLength, "21cm"); assert.equal(saved.bladeWidth, "4mm");
      const edit = page.locator(`[data-action="edit-order"][data-order-id="${saved.id}"]`).first();
      await edit.click();
      assert.equal(await form.locator('[name="specShape"]').inputValue(), fixture.shape, "opening an old nonempty shape does not repair it");
      await page.locator('[data-action="close-order-dialog"]').first().click();
      await page.locator("#order-dialog").waitFor({ state: "hidden" });
    }
    evidence.push({ product: fixture.product, savedShape: saved.specShape, reloaded: true, explicitPreserved: Boolean(fixture.explicit) });
  }

  const body = "得意先: N04本文\n品名: 鋭匙鉗子 弱弯・上向\n数量: 3\n連番: N04-BULK-1\n\n品名: 鋭匙鉗子 強彎/下向\n数量: 5\n連番: N04-BULK-2";
  await page.locator('[data-action="open-import"]').first().click();
  await page.locator("#import-text-tab").click();
  await page.locator("#text-import-subject").fill("N04形状比較");
  await page.locator("#text-import-body").fill(body);
  await page.locator("#text-import-form button[type=submit]").click();
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  await selectQaView(page, "intake");
  await page.locator('[data-action="open-bulk-intake"]').click();
  await page.locator("#bulk-intake-dialog").waitFor({ state: "visible" });
  assert.deepEqual(await page.locator('[data-bulk-field="specShape"]').evaluateAll(fields => fields.map(field => field.value)), ["弱弯・上向", "強弯・下向"]);
  // Disable optional learning to keep this QA about parsing/approval only.
  await page.locator("#bulk-intake-learn-product").uncheck();
  await page.locator("#bulk-intake-submit").click();
  await page.locator("#bulk-intake-dialog").waitFor({ state: "hidden" });
  await page.reload(); await waitForQaReady(page);
  const imported = await page.evaluate(() => api.read().jobs.filter(job => job.serialNo?.startsWith("N04-BULK")).sort((a, b) => a.serialNo.localeCompare(b.serialNo)));
  assert.deepEqual(imported.map(job => job.specShape), ["弱弯・上向", "強弯・下向"]);
  assert.deepEqual(imported.map(job => job.quantity), [3, 5]);
  evidence.push({ pastedOrder: true, bulkApproval: true, reloadedShapes: imported.map(job => job.specShape), quantities: imported.map(job => job.quantity) });
  await writeFile(path.join(output, `${label}-inference-evidence.json`), JSON.stringify(evidence, null, 2));
});
