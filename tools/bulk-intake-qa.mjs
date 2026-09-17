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
const field = (n, name) => row(n).locator(`[data-bulk-field='${name}']`);
try {
  await page.goto(process.env.PROGRESS_BOARD_QA_URL || "http://127.0.0.1:4177/dist/Index.html", { waitUntil: "networkidle" });
  const count = (await data()).jobs.length;
  await page.locator("[data-action='open-import']").first().click();
  await page.locator("#import-text-tab").click();
  await page.locator("#text-import-body").fill("得意先: 田中\n品名: ケリソン18cm上向3mm\n数量: 10\n納期: 2026-11-30\n連番: BULK-1\n\n品名: 鋭匙鉗子21cm直4mm\n納期: 2026-11-30\n連番: BULK-2\n\n品名: 彫骨器18cm2mm\n数量: 5\n連番: BULK-3");
  await page.locator("#text-import-form button[type=submit]").click();
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  await page.locator("[data-action='open-bulk-intake']").click();
  assert.equal(await page.locator(".bulk-intake-row").count(), 3);
  assert.equal(await field(0, "specLength").inputValue(), "18cm");
  assert.equal(await field(0, "bladeWidth").inputValue(), "3mm");
  assert.equal(await field(2, "category").inputValue(), "ケリソンパンチ");
  await field(0, "quantity").fill("12");
  await field(1, "quantity").fill("");
  await field(1, "note").fill("一括編集の確認");
  await page.locator("#bulk-intake-submit").click();
  assert.match(await page.locator("#bulk-intake-result").innerText(), /まだ反映していません/);
  assert.equal((await data()).jobs.length, count);
  assert.equal(await field(1, "quantity").getAttribute("aria-invalid"), "true");
  await page.locator("[data-action='close-bulk-intake']").click();
  await page.locator("[data-action='open-bulk-intake']").click();
  assert.equal(await field(0, "quantity").inputValue(), "12");
  assert.equal(await field(1, "note").inputValue(), "一括編集の確認");
  await field(1, "quantity").fill("7");
  // Inject only in the isolated local browser: the real server is never mutated.
  await page.evaluate(() => {
    window.qaOriginalBulkApprove = api.approveIntakes.bind(api);
    api.approveIntakes = () => new Promise((resolve, reject) => { window.qaRejectBulk = reject; });
  });
  await page.locator("#bulk-intake-submit").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#bulk-intake-dialog").evaluate((el) => el.open), true);
  assert.equal(await page.locator("#main-content").evaluate((el) => el.inert), true);
  await page.evaluate(() => window.qaRejectBulk(new Error("検証用の通信切断")));
  await page.getByText(/反映結果を確認できません。検証用の通信切断/).waitFor();
  assert.equal(await field(1, "quantity").inputValue(), "7");
  assert.equal((await data()).jobs.length, count);
  await page.evaluate(() => { api.approveIntakes = window.qaOriginalBulkApprove; });
  await mkdir("output/playwright", { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 375, 414, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1024 });
      assert.ok(await page.locator("#bulk-intake-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width} dialog overflow`);
      assert.ok(await page.locator(".bulk-intake-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width} body overflow`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} root overflow`);
      if ([320, 768, 1280, 1440].includes(width)) await page.screenshot({ path: `output/playwright/bulk-intake-${theme}-${width}.png`, fullPage: true });
    }
  }
  await row(2).locator("[data-bulk-select]").uncheck();
  assert.equal(await page.locator("#bulk-intake-all").evaluate((el) => el.indeterminate), true);
  assert.equal(await field(2, "quantity").isDisabled(), true);
  await page.evaluate(() => {
    api.approveIntakes = async (payload) => {
      const saved = await window.qaOriginalBulkApprove({ items: [payload.items[0]] });
      return { items: saved.items, errors: [{ intakeId: payload.items[1].intakeId, message: "検証用の行保存エラー" }] };
    };
  });
  await page.locator("#bulk-intake-submit").click();
  await page.getByText("検証用の行保存エラー", { exact: true }).waitFor();
  assert.equal((await data()).jobs.length, count + 1);
  assert.equal(await field(0, "quantity").inputValue(), "7");
  assert.equal(await field(0, "note").inputValue(), "一括編集の確認");
  await page.evaluate(() => { api.approveIntakes = window.qaOriginalBulkApprove; });
  await page.locator("#bulk-intake-submit").click();
  await page.waitForFunction(() => document.querySelector("#bulk-intake-result").textContent.includes("1件を案件へ反映しました"));
  let saved = await data();
  assert.equal(saved.jobs.length, count + 2);
  assert.equal(saved.jobs.find((job) => job.serialNo === "BULK-1").quantity, 12);
  assert.equal(saved.jobs.find((job) => job.serialNo === "BULK-2").note, "一括編集の確認");
  assert.equal(saved.intake.filter((item) => item.status === "pending").length, 1);
  assert.equal(await page.locator(".bulk-intake-row").count(), 1);
  await page.locator("#bulk-intake-all").check();
  await page.locator("#bulk-intake-submit").click();
  await page.locator("#bulk-intake-dialog").waitFor({ state: "hidden" });
  saved = await data();
  const jobs = saved.jobs.filter((job) => job.serialNo.startsWith("BULK-"));
  assert.equal(jobs.length, 3);
  assert.equal(new Set(jobs.map((job) => job.id)).size, 3);
  assert.ok(jobs.every((job) => job.labelPrintStatus === "waiting" && job.shippingStatus === "not_ready"));
  assert.ok(jobs.every((job) => Object.values(job.stages).every((stage) => stage.status === "not_started")));
  assert.deepEqual(errors, []);
  console.log("PASS bulk review: real text parse, edits, validation, retained drafts, selected approval, label queue, light/dark at six widths");
} finally { await browser.close(); }
