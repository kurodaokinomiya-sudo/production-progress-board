import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kurom/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "output", "playwright");
const baseUrl = process.env.PROGRESS_BOARD_QA_URL || "http://127.0.0.1:4173";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
const errors = [];
await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, async (route) => {
  await route.fulfill({ status: 200, contentType: route.request().url().includes("googleapis") ? "text/css" : "font/woff2", body: "" });
});
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

async function selectView(view) {
  const target = page.locator(`[data-view='${view}']`);
  if (!await target.isVisible()) {
    await page.locator("[data-action='toggle-nav']").click();
  }
  await target.click();
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("production-board-demo-v2"));
  await page.reload({ waitUntil: "networkidle" });
  const japanDateLabel = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }).format(new Date());
  assert.equal(await page.locator("#today-label").textContent(), japanDateLabel);
  await page.locator("[data-action='show-due-orders']").click();
  assert.equal(await page.locator("#orders-attention-filter").inputValue(), "due");
  assert.ok(await page.locator("#orders-workspace .order-card").count() > 0);
  await selectView("dashboard");
  await page.locator("[data-action='show-shipping-orders']").click();
  assert.equal(await page.locator("#orders-attention-filter").inputValue(), "shipping");
  assert.equal(await page.locator("#orders-workspace .order-card").count(), 2);
  await page.locator("#orders-workspace [data-action='open-process'][data-order-id='DEMO-005']:visible").first().click();
  const lifecycleAction = page.locator("#process-lifecycle-action");
  assert.equal((await lifecycleAction.textContent()).trim(), "出荷完了・終了へ");
  assert.equal(await lifecycleAction.isEnabled(), true);
  await page.screenshot({ path: path.join(output, "process-dialog-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "工程画面を閉じる" }).click();
  await selectView("dashboard");
  const orderOpener = page.getByRole("button", { name: "案件を追加" }).first();
  await orderOpener.click();
  const form = page.locator("#order-form");
  await form.locator("[name='customer']").fill("QA商事");
  await form.locator("[name='serialNo']").fill("26-0001-10");
  await form.locator("[name='note']").fill("写真撮影・刻印あり\n仕上げ後に確認");
  await form.locator("[name='product']").fill("スタンツェ 18cm 弱弯 2mm");
  await form.locator("[name='product']").press("Tab");
  assert.equal(await form.locator("[name='category']").inputValue(), "ケリソンパンチ");
  assert.equal(await form.locator("[name='specLength']").inputValue(), "18cm");
  assert.equal(await form.locator("[name='specShape']").inputValue(), "弱弯");
  assert.equal(await form.locator("[name='bladeWidth']").inputValue(), "2mm");

  await form.locator("[name='product']").fill("鋭匙鉗子 上曲左 全長１２００ミリ 刃の幅３．５ミリ");
  await form.locator("[name='product']").press("Tab");
  assert.equal(await form.locator("[name='category']").inputValue(), "鋭匙鉗子");
  assert.equal(await form.locator("[name='specLength']").inputValue(), "1200mm");
  assert.equal(await form.locator("[name='specShape']").inputValue(), "上曲左");
  assert.equal(await form.locator("[name='bladeWidth']").inputValue(), "3.5mm");

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: path.join(output, "auto-classify-tablet.png"), fullPage: true });
  await form.getByRole("button", { name: "注文情報を保存" }).click();
  await page.locator("#order-dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  assert.equal(await orderOpener.evaluate((element) => element === document.activeElement), true);

  await selectView("orders");
  await page.locator("#orders-attention-filter").selectOption("all");
  const qaCard = page.locator("#orders-workspace .order-card").filter({ hasText: "QA商事" });
  await qaCard.locator("[data-action='open-process'][data-stage-key='welding']").click();
  assert.equal((await lifecycleAction.textContent()).trim(), "出荷完了・終了へ");
  assert.equal(await lifecycleAction.isDisabled(), true);
  const processForm = page.locator("#process-form");
  const weldingRow = processForm.locator("[data-stage-key='welding']");
  await page.screenshot({ path: path.join(output, "process-dialog-tablet.png"), fullPage: true });
  await weldingRow.getByRole("button", { name: "完了", exact: true }).click();
  const weldingAssigneeTrigger = weldingRow.locator(".assignee-trigger");
  if (await weldingAssigneeTrigger.getAttribute("aria-expanded") !== "true") await weldingAssigneeTrigger.click();
  await weldingRow.getByRole("button", { name: "豊", exact: true }).click();
  await processForm.getByRole("button", { name: "工程を保存" }).click();
  await page.locator("#process-dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  const quickStageState = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem("production-board-demo-v2"));
    return data.jobs.find((job) => job.customer === "QA商事")?.stages?.welding;
  });
  assert.deepEqual(quickStageState, { status: "done", assignee: "豊" });
  await qaCard.locator("[data-action='edit-order']").click();
  await form.locator("[name='product']").fill("ケリソン 18cm 弱弯 2mm");
  await form.locator("[name='product']").press("Tab");
  assert.equal(await form.locator("[name='category']").inputValue(), "ケリソンパンチ");
  assert.equal(await form.locator("[name='specLength']").inputValue(), "18cm");
  assert.equal(await form.locator("[name='specShape']").inputValue(), "弱弯");
  assert.equal(await form.locator("[name='bladeWidth']").inputValue(), "2mm");
  await form.locator("[name='product']").fill("鋭匙鉗子 上曲左 全長1200mm 刃幅3.5mm");
  await form.locator("[name='product']").press("Tab");
  assert.equal(await form.locator("[name='category']").inputValue(), "鋭匙鉗子");
  assert.equal(await form.locator("[name='specLength']").inputValue(), "1200mm");
  assert.equal(await form.locator("[name='specShape']").inputValue(), "上曲左");
  assert.equal(await form.locator("[name='bladeWidth']").inputValue(), "3.5mm");
  await page.getByRole("button", { name: "案件画面を閉じる" }).click();

  await qaCard.locator("[data-action='edit-order']").click();
  await form.getByRole("button", { name: "案件を削除" }).click();
  await page.locator("#order-dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#orders-workspace .order-card").filter({ hasText: "QA商事" }).count(), 0);
  await page.getByRole("button", { name: "元に戻す" }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#orders-workspace .order-card").filter({ hasText: "QA商事" }).count(), 1);

  await qaCard.locator("[data-action='open-process'][data-stage-key='welding']").click();
  const processDialogOverflow = [];
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await page.locator("#process-dialog").evaluate((dialog) => ({
      width: window.innerWidth,
      dialogClient: dialog.clientWidth,
      dialogScroll: dialog.scrollWidth,
      rootClient: document.documentElement.clientWidth,
      rootScroll: document.documentElement.scrollWidth,
    }));
    processDialogOverflow.push(result);
    assert.ok(result.dialogScroll <= result.dialogClient && result.rootScroll <= result.rootClient, `process dialog overflow at ${width}px: ${JSON.stringify(result)}`);
  }
  await page.getByRole("button", { name: "工程画面を閉じる" }).click();

  await page.locator("#orders-sort").selectOption("category");
  await page.waitForTimeout(50);
  const categoryCards = await page.locator("#orders-workspace .order-card .category-chip").allTextContents();
  const categoryRanks = categoryCards.map((value) => ({ "鋭匙鉗子": 0, "ケリソンパンチ": 1, "未分類": 2 })[value.trim()] ?? 3);
  assert.deepEqual(categoryRanks, [...categoryRanks].sort((a, b) => a - b));
  assert.equal(categoryCards[0], "鋭匙鉗子");

  await page.locator("#orders-sort").selectOption("serial");
  await page.waitForTimeout(50);
  const serialCards = await page.locator("#orders-workspace .order-card .order-meta span:nth-child(2)").allTextContents();
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const serials = serialCards.map((value) => value.replace(/^連番\s*/, "").trim());
  assert.deepEqual(serials, [...serials].sort(collator.compare));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#orders-sort").selectOption("category");
  await page.waitForTimeout(50);
  const tableIds = await page.locator("#orders-workspace tbody tr").evaluateAll((rows) => rows.map((row) => row.dataset.orderId));
  const cardIds = await page.locator("#orders-workspace .order-card").evaluateAll((cards) => cards.map((card) => card.dataset.orderId));
  assert.deepEqual(tableIds, cardIds);
  const qaRow = page.locator("#orders-workspace tbody tr").filter({ hasText: "QA商事" });
  assert.equal(await qaRow.locator(".cell-length").textContent(), "1200mm");
  assert.equal(await qaRow.locator(".cell-shape").textContent(), "上曲左");
  assert.equal(await qaRow.locator(".cell-blade").textContent(), "3.5mm");
  assert.equal(await qaRow.locator(".cell-note").textContent(), "写真撮影・刻印あり 仕上げ後に確認");
  assert.equal(await qaRow.locator(".stage-cell-button").count(), 5);
  assert.match(await qaRow.locator("[data-stage-key='welding']").textContent(), /豊.*完了/);
  for (const stageKey of ["welding", "base", "grinding", "heat", "finish"]) {
    await qaRow.locator(`[data-stage-key='${stageKey}']`).click();
    assert.equal(await processForm.locator(`.stage-edit-row[data-stage-key='${stageKey}']`).getAttribute("class"), "stage-edit-row is-current");
    await page.getByRole("button", { name: "工程画面を閉じる" }).click();
  }
  const ledgerLayouts = [];
  for (const width of [320, 375, 414, 768, 1024, 1248, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const buttons = [...document.querySelectorAll("#orders-workspace .stage-cell-button")].filter((el) => el.getClientRects().length);
      const clippedCells = [...document.querySelectorAll("#orders-workspace td")].filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map((el) => el.className);
      return { width: innerWidth, overflow: root.scrollWidth > root.clientWidth, touchMin: Math.min(...buttons.map((el) => el.getBoundingClientRect().width)), clippedCells };
    });
    assert.equal(result.overflow, false, JSON.stringify(result));
    assert.ok(result.touchMin >= 43.9, JSON.stringify(result));
    assert.deepEqual(result.clippedCells, [], JSON.stringify(result));
    ledgerLayouts.push(result);
    if (width < 1248) {
      assert.equal(await qaCard.locator(".order-specs dd").allTextContents().then((values) => values.includes("1200mm") && values.includes("3.5mm")), true);
    }
    if ([320, 768, 1280, 1440].includes(width)) await page.screenshot({ path: path.join(output, `spec-ledger-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, "category-sort-desktop.png"), fullPage: true });

  await page.evaluate(() => {
    const key = "production-board-demo-v2";
    const data = JSON.parse(localStorage.getItem(key));
    const source = data.jobs.find((job) => job.id === "DEMO-001");
    data.jobs.forEach((job) => { job.labelPrintStatus = "waiting"; job.labelPrintedAt = ""; });
    data.jobs.push({
      ...source,
      id: "LABEL-QA-10",
      customer: "田中",
      product: "Yカーブドケリソン 上向",
      specLength: "21cm",
      specShape: "上向",
      bladeWidth: "3mm",
      serialNo: "26-1561-1",
      quantity: 10,
      dueDate: "2026-09-30",
      labelPrintStatus: "reprint",
      labelPrintedAt: "",
      updatedAt: new Date().toISOString(),
    });
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("#metric-label").textContent(), "10");
  await page.screenshot({ path: path.join(output, "label-queue-dashboard-desktop.png"), fullPage: true });
  await selectView("orders");
  const labelOpener = page.locator(".header-actions [data-action='open-label-print']");
  await labelOpener.click();
  const labelDialog = page.locator("#label-dialog");
  assert.equal(await labelDialog.getAttribute("open"), "");
  assert.equal(await page.locator("#label-status-filter").evaluate((element) => element === document.activeElement), true);
  const labelIds = await labelDialog.locator("[data-label-job-id]").evaluateAll((inputs) => inputs.map((input) => input.dataset.labelJobId));
  assert.equal(labelIds.length, 10);
  assert.equal(await page.locator("#label-selection-count").textContent(), "9 / 9枚");
  assert.equal(await page.locator("#label-preview-list .product-label").count(), 9);
  assert.equal(await labelDialog.locator("[data-label-job-id]:disabled").count(), 1);
  const referenceLabel = page.locator("#label-preview-list .product-label").filter({ hasText: "26-1561-1" });
  assert.deepEqual(await referenceLabel.locator(".label-spec-value").allTextContents(), ["210", "上向", "3mm", "26-1561-1", "10", "09/30"]);
  const previewRows = await referenceLabel.evaluate((element) => ({
    labelHeight: element.getBoundingClientRect().height,
    specHeight: element.querySelector(".label-spec-grid").getBoundingClientRect().height,
  }));
  assert.ok(previewRows.specHeight / previewRows.labelHeight > 0.4, JSON.stringify(previewRows));
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.screenshot({ path: path.join(output, "label-print-preview-tablet.png"), fullPage: true });
  await page.evaluate(() => { window.print = () => { window.__labelPrintCalls = (window.__labelPrintCalls || 0) + 1; }; });
  await page.getByRole("button", { name: "9枚を印刷" }).click();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__labelPrintCalls), 1);
  assert.equal(await page.locator("#label-print-sheet .product-label").count(), 9);
  await page.emulateMedia({ media: "print" });
  const labelPhysicalSize = await page.locator("#label-print-sheet .product-label").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: parseFloat(style.width), height: parseFloat(style.height) };
  });
  assert.ok(Math.abs(labelPhysicalSize.width * 25.4 / 96 - 150) < 0.2, JSON.stringify(labelPhysicalSize));
  assert.ok(Math.abs(labelPhysicalSize.height * 25.4 / 96 - 30) < 0.2, JSON.stringify(labelPhysicalSize));
  await page.pdf({ path: path.join(output, "product-labels-a4.pdf"), printBackground: true, preferCSSPageSize: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-printing-labels")), false);
  assert.equal(await page.locator("#label-print-result").isVisible(), true);
  await page.screenshot({ path: path.join(output, "label-print-confirmation-tablet.png"), fullPage: true });
  await page.getByRole("button", { name: "印刷済みにする" }).click();
  await page.locator("#label-print-result").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#label-selection-count").textContent(), "0 / 9枚");
  assert.equal(await page.locator("#label-job-list [data-label-job-id]").count(), 1);
  const labelStateAfterPrint = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem("production-board-demo-v2"));
    return {
      printed: data.jobs.filter((job) => job.labelPrintStatus === "printed").length,
      waiting: data.jobs.filter((job) => ["waiting", "reprint"].includes(job.labelPrintStatus)).length,
      reference: data.jobs.find((job) => job.id === "LABEL-QA-10")?.labelPrintStatus,
    };
  });
  assert.deepEqual(labelStateAfterPrint, { printed: 9, waiting: 1, reference: "printed" });
  await page.getByRole("button", { name: "ラベル印刷画面を閉じる" }).click();
  await labelDialog.waitFor({ state: "hidden" });
  await page.waitForFunction((element) => element === document.activeElement, await labelOpener.elementHandle());
  assert.equal(await labelOpener.evaluate((element) => element === document.activeElement), true);

  await page.locator("#orders-workspace [data-action='edit-order'][data-order-id='LABEL-QA-10']:visible").first().click();
  await form.locator("[name='quantity']").fill("11");
  await form.getByRole("button", { name: "注文情報を保存" }).click();
  await page.locator("#order-dialog").waitFor({ state: "hidden" });
  const reprintState = await page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find((job) => job.id === "LABEL-QA-10")?.labelPrintStatus);
  assert.equal(reprintState, "reprint");

  const importOpener = page.locator("[data-action='open-import']").first();
  await importOpener.click();
  const imageTab = page.locator("#import-image-tab");
  const emailTab = page.locator("#import-email-tab");
  await imageTab.focus();
  await imageTab.press("ArrowRight");
  const textTab = page.locator("#import-text-tab");
  assert.equal(await textTab.getAttribute("aria-selected"), "true");
  assert.equal(await textTab.evaluate((element) => element === document.activeElement), true);
  await textTab.press("ArrowRight");
  assert.equal(await emailTab.getAttribute("aria-selected"), "true");
  assert.equal(await emailTab.evaluate((element) => element === document.activeElement), true);
  await emailTab.press("Home");
  assert.equal(await imageTab.getAttribute("aria-selected"), "true");
  await imageTab.press("Escape");
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(50);
  assert.equal(await page.locator("body > [inert]").count(), 0);
  assert.equal(await importOpener.evaluate((element) => element === document.activeElement), true);

  await page.evaluate(() => {
    const key = "production-board-demo-v2";
    const data = JSON.parse(localStorage.getItem(key));
    ["DEMO-005", "DEMO-008"].forEach((id) => {
      const job = data.jobs.find((entry) => entry.id === id);
      if (job) {
        job.shippingStatus = "shipped";
        job.completedAt = new Date().toISOString();
        job.updatedAt = new Date().toISOString();
      }
    });
    data.intake.unshift({
      id: "INTAKE-QA",
      sourceType: "email",
      sourceRef: "qa-message",
      receivedAt: new Date().toISOString(),
      sender: "qa@example.test",
      subject: "ケリパンチ",
      originalText: "品名：ケリパンチ 弱弯2mm",
      parsed: { customer: "QA取込", product: "ケリパンチ 弱弯2mm", category: "ケリソンパンチ", dueDate: "", quantity: 1, serialNo: "QA-1", specLength: "", specShape: "弱弯", bladeWidth: "2mm", note: "" },
      confidence: 0.9,
      status: "pending",
    });
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload({ waitUntil: "networkidle" });
  await selectView("intake");
  await page.getByRole("button", { name: "内容を確認する" }).click();
  const intakeForm = page.locator("#intake-form");
  await intakeForm.locator("[name='product']").fill("鋭匙鉗子 上曲左 全長1200mm 刃幅3.5mm");
  await intakeForm.locator("[name='product']").press("Tab");
  assert.equal(await intakeForm.locator("[name='category']").inputValue(), "鋭匙鉗子");
  assert.equal(await intakeForm.locator("[name='specLength']").inputValue(), "1200mm");
  assert.equal(await intakeForm.locator("[name='specShape']").inputValue(), "上曲左");
  assert.equal(await intakeForm.locator("[name='bladeWidth']").inputValue(), "3.5mm");
  await intakeForm.getByRole("button", { name: "確認して案件へ反映" }).click();
  await page.locator("#intake-dialog").waitFor({ state: "hidden" });
  const importedLabelState = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem("production-board-demo-v2"));
    return data.jobs.find((job) => job.customer === "QA取込")?.labelPrintStatus;
  });
  assert.equal(importedLabelState, "waiting");
  assert.equal(await page.locator("body > [inert]").count(), 0);

  await selectView("dashboard");
  await page.locator("[data-action='show-current-completed']").click();
  assert.equal(await page.locator("#completed-period").inputValue(), "current");
  await page.locator("#completed-sort").selectOption("category");
  await page.waitForTimeout(50);
  assert.equal(await page.locator("#completed-workspace .order-card").count(), 2);
  assert.equal(await page.locator("#completed-workspace .order-card").first().getByText(/^出荷完了 /).count(), 1);

  const overflowResults = [];
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await page.evaluate(() => ({
      width: window.innerWidth,
      rootClient: document.documentElement.clientWidth,
      rootScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    overflowResults.push(result);
    assert.ok(result.rootScroll <= result.rootClient && result.bodyScroll <= result.rootClient, `horizontal overflow at ${width}px: ${JSON.stringify(result)}`);
  }

  await page.setViewportSize({ width: 768, height: 1024 });
  await selectView("settings");
  await page.getByRole("button", { name: "ダーク", exact: true }).click();
  await selectView("completed");
  assert.equal(await page.locator("[data-view-panel='completed']").getAttribute("hidden"), null);
  assert.equal(await page.locator("#completed-workspace .order-card").count(), 2);
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(await page.locator("body > [inert]").count(), 0);
  await page.waitForTimeout(500);
  const darkComputed = await page.evaluate(() => {
    const style = (selector) => {
      const element = document.querySelector(selector);
      const computed = getComputedStyle(element);
      return { color: computed.color, background: computed.backgroundColor, opacity: computed.opacity };
    };
    return { html: style("html"), body: style("body"), heading: style("#completed-title"), card: style("#completed-workspace .order-card") };
  });
  await page.screenshot({ path: path.join(output, "category-sort-completed-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await selectView("orders");
  await page.screenshot({ path: path.join(output, "spec-ledger-dark-1280.png"), fullPage: true });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    autoClassification: "pass",
    autoSpecRefresh: "pass",
    categorySort: categoryCards,
    serialSort: serials,
    tableCardOrderMatch: true,
    dialogFocusReturn: true,
    dialogEscapeCleanup: true,
    labelPrint: { selected: 9, disabledAfterLimit: 1, markedPrinted: 9, reprintAfterEdit: true, intakeAutoQueued: true, physicalSizeMm: { width: 150, height: 30 } },
    importTabKeyboard: true,
    existingOrderInferenceRefresh: true,
    intakeInferenceRefresh: true,
    japanBusinessDate: japanDateLabel,
    statusRegisterNavigation: true,
    lifecycleActionClarity: true,
    quickProcessUpdate: quickStageState,
    specificationLedger: ledgerLayouts,
    softDeleteUndo: true,
    processDialogOverflow,
    completedSortCount: 2,
    overflow: overflowResults,
    browserErrors: errors.length,
    darkComputed,
    screenshots: ["process-dialog-desktop.png", "process-dialog-tablet.png", "auto-classify-tablet.png", "category-sort-desktop.png", "label-queue-dashboard-desktop.png", "label-print-preview-tablet.png", "label-print-confirmation-tablet.png", "category-sort-completed-dark.png"],
    printPdf: "product-labels-a4.pdf",
  }, null, 2));
} finally {
  await browser.close();
}
