import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kurom/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route(/https:\/\/fonts\./, (route) => route.fulfill({ body: "" }));
const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")));
const row = (n) => page.locator(".bulk-intake-row").nth(n);
const confirm = () => page.locator("#bulk-intake-dialog [data-action='confirm-intake-delete']").click();
const waitCount = (n) => page.waitForFunction((count) => document.querySelectorAll(".bulk-intake-row").length === count && !bulkIntakeBusy, n);
try {
  await page.goto(process.env.PROGRESS_BOARD_QA_URL || "http://127.0.0.1:4178/dist/Index.html", { waitUntil: "networkidle" });
  const originalJobs = (await data()).jobs;
  await page.locator("[data-action='open-import']").first().click();
  await page.locator("#import-text-tab").click();
  await page.locator("#text-import-body").fill("得意先: 削除確認用\n品名: ケリソン18cm\n数量: 1\n連番: DELETE-1\n\n品名: 鋭匙鉗子21cm\n数量: 2\n連番: DELETE-2\n\n品名: 彫骨器18cm\n数量: 3\n連番: DELETE-3\n\n品名: ケリソン20cm\n数量: 4\n連番: DELETE-4");
  await page.locator("#text-import-form button[type=submit]").click();
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  await page.locator("[data-action='open-bulk-intake']").click();
  assert.equal(await page.locator(".bulk-intake-row").count(), 4);
  await page.locator("#bulk-intake-all").uncheck();
  assert.equal(await page.locator("#bulk-intake-delete").isDisabled(), true);
  await row(0).locator("[data-action='delete-intake-row']").click();
  await page.locator("#bulk-intake-dialog [data-action='cancel-intake-delete']").click();
  assert.equal((await data()).intake.filter((item) => item.status === "pending").length, 4);
  // Delete one unchecked row without validating any of its fields.
  await row(0).locator("[data-action='delete-intake-row']").click();
  await confirm();
  await waitCount(3);
  await page.locator("#bulk-intake-all").check();
  await row(0).locator("[data-bulk-field='quantity']").fill("");
  await row(0).locator("[data-bulk-field='note']").fill("失敗時も保持する編集");
  await row(2).locator("[data-bulk-select]").uncheck();
  assert.equal(await page.locator("#bulk-intake-all").evaluate((el) => el.indeterminate), true);
  // A partial backend failure must preserve failed drafts and unselected rows.
  await page.evaluate(() => {
    window.originalRejectIntakes = api.rejectIntakes.bind(api);
    api.rejectIntakes = async ({ intakeIds }) => {
      const saved = await window.originalRejectIntakes({ intakeIds: [intakeIds[1]] });
      return { items: saved.items, errors: [{ intakeId: intakeIds[0], message: "検証用の保存エラー" }] };
    };
  });
  await page.locator("#bulk-intake-delete").click();
  assert.match(await page.locator("#bulk-intake-dialog [data-intake-delete-confirm] p").innerText(), /2件/);
  assert.equal(await row(0).locator("[data-bulk-select]").isDisabled(), true);
  await confirm();
  await waitCount(2);
  assert.match(await page.locator("#bulk-intake-result").innerText(), /1件を削除、1件は未完了/);
  assert.equal(await row(0).locator("[data-bulk-field='quantity']").inputValue(), "");
  assert.equal(await row(0).locator("[data-bulk-field='note']").inputValue(), "失敗時も保持する編集");
  // A lost response after a committed deletion can be retried safely.
  await page.evaluate(() => {
    api.rejectIntakes = async (payload) => {
      await window.originalRejectIntakes(payload);
      return new Promise((resolve, reject) => { window.failDeleteResponse = () => reject(new Error("検証用の通信切断")); });
    };
  });
  await page.locator("#bulk-intake-delete").click();
  await confirm();
  await page.waitForFunction(() => Boolean(window.failDeleteResponse));
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#bulk-intake-dialog").evaluate((el) => el.open), true);
  assert.equal(await page.locator("#bulk-intake-submit").isDisabled(), true);
  await page.evaluate(() => window.failDeleteResponse());
  await page.locator("#bulk-intake-result").filter({ hasText: /0件を削除、1件は未完了/ }).waitFor();
  await page.evaluate(() => { api.rejectIntakes = window.originalRejectIntakes; });
  await page.locator("#bulk-intake-delete").click();
  await confirm();
  await waitCount(1);
  assert.equal(await row(0).locator("[data-bulk-select]").isChecked(), false);
  await page.locator("#bulk-intake-all").check();
  await page.locator("#bulk-intake-delete").click();
  await mkdir("output/playwright", { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 1024 });
      assert.ok(await page.locator(".bulk-intake-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width} overflow`);
      await page.screenshot({ path: `output/playwright/intake-delete-${theme}-${width}.png`, fullPage: true });
    }
  }
  await confirm();
  await page.locator("#bulk-intake-dialog").waitFor({ state: "hidden" });
  assert.equal((await data()).intake.filter((item) => item.status === "pending").length, 0);
  assert.deepEqual((await data()).jobs, originalJobs);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-intake-id]").count(), 0);
  // Seed only this isolated local browser to verify >100 selection and individual editor.
  await page.evaluate(async () => {
    const saved = api.read();
    saved.intake = Array.from({ length: 102 }, (_, index) => ({
      id: `DELETE-BATCH-${index}`, status: "pending", parserVersion: 2, sourceType: "text", sourceRef: `qa:${index}`,
      parsed: { customer: "ローカル検証", product: `削除用${index}`, quantity: "" },
    }));
    api.write(saved);
    await refreshData({ quiet: true });
  });
  await page.locator("[data-view='intake']").click();
  await page.locator("[data-intake-id]").first().click();
  await page.locator("#intake-dialog [data-action='reject-intake']").click();
  await page.locator("#intake-dialog [data-action='confirm-intake-delete']").click();
  await page.locator("#intake-dialog").waitFor({ state: "hidden" });
  assert.equal((await data()).intake.filter((item) => item.status === "pending").length, 101);
  await page.locator("[data-action='open-bulk-intake']").click();
  await page.locator("#bulk-intake-delete").click();
  assert.match(await page.locator("#bulk-intake-dialog [data-intake-delete-confirm] p").innerText(), /101件/);
  await confirm();
  await page.locator("#bulk-intake-dialog").waitFor({ state: "hidden" });
  assert.equal((await data()).intake.filter((item) => item.status === "pending").length, 0);
  assert.deepEqual((await data()).jobs, originalJobs);
  assert.deepEqual(errors, []);
  console.log("PASS intake deletion: individual, unchecked row, selected/all/none, cancel, invalid fields, partial failure, lost-response retry, busy guard, reload persistence, 101-item batch, light/dark responsive layouts; jobs unchanged");
} finally {
  await browser.close();
}
