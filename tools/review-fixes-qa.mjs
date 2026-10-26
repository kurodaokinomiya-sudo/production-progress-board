import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, qaBaseUrl } from "./browser-runtime.mjs";

// Deliberately limited to a dedicated local origin and ephemeral demo storage.
const pageUrl = await qaBaseUrl("/src/index.html");
const ORIGIN = new globalThis.URL(pageUrl).origin;
const STORAGE = "production-board-demo-v2";
const OUT = path.resolve("output/review-fixes-2026-10-09");
const results = [];
const runtimeErrors = [];
const shots = [];
let base;
let page;
let browser;
let context;
let fixtureNumber = 0;

async function shot(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  shots.push(file);
  return file;
}

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, pass: true, milliseconds: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    const item = { name, pass: false, milliseconds: Date.now() - started, error: error.stack || String(error) };
    try { item.screenshot = await shot(`failure-${results.length + 1}`); } catch {}
    results.push(item);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function ready(target = page) {
  await target.waitForFunction(() => /\d+件/.test(document.querySelector("#orders-result-count")?.textContent || ""));
}

async function storage(target = page) {
  return target.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE);
}

async function fixture(jobs, intake = [], extras = {}) {
  fixtureNumber += 1;
  const value = { ...structuredClone(base), jobs, intake, logs: [], ...extras };
  await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
    localStorage.removeItem("production-board-ledger-display-v1");
    localStorage.setItem("production-board-theme", "light");
  }, { key: STORAGE, value });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  return value;
}

function job(id, overrides = {}) {
  const seed = structuredClone(base.jobs[0]);
  const at = new Date().toISOString();
  return {
    ...seed,
    id,
    customer: "QA 得意先",
    product: "QA ケリソンパンチ 18cm 直 2mm",
    quantity: 4,
    serialNo: `QA-${fixtureNumber}-${id}`,
    dueDate: "2026-11-10",
    sourceType: "manual",
    sourceRef: "",
    note: "",
    stages: Object.fromEntries(Object.keys(seed.stages).map((key) => [key, { status: "not_started", assignee: "" }])),
    shippingStatus: "not_ready",
    labelPrintStatus: "not_required",
    labelPrintedAt: "",
    archived: false,
    completedAt: "",
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...overrides,
  };
}

function candidate(id, overrides = {}) {
  const parsed = {
    customer: "QA 得意先",
    product: "QA ケリソンパンチ 18cm 直 2mm",
    quantity: 4,
    serialNo: "QA-DUPLICATE",
    dueDate: "2026-11-10",
    category: "ケリソンパンチ",
    specLength: "18cm",
    specShape: "直",
    bladeWidth: "2mm",
    note: "",
    ...(overrides.parsed || {}),
  };
  return {
    id,
    sourceType: "text",
    sourceRef: `qa-local:${id}`,
    subject: "QA 評価専用取込",
    originalText: `QA 評価専用: ${parsed.customer} / ${parsed.serialNo} / ${parsed.product}`,
    receivedAt: new Date().toISOString(),
    status: "pending",
    parserVersion: base.localIntakeParserVersion,
    ...overrides,
    parsed,
  };
}

async function nav(view, target = page) {
  const button = target.locator(`[data-view="${view}"]`);
  if (!await button.isVisible()) {
    const menu = target.locator('[data-action="toggle-nav"]');
    if (await menu.isVisible()) await menu.click();
  }
  await button.click();
  await target.locator(`[data-view-panel="${view}"]`).waitFor({ state: "visible" });
}

async function openBulk() {
  await nav("intake");
  await page.locator('[data-action="open-bulk-intake"]').click();
  await page.locator("#bulk-intake-dialog[open]").waitFor();
}

async function openSingle(id) {
  await nav("intake");
  await page.locator(`#intake-list [data-intake-id="${id}"]`).click();
  await page.locator("#intake-dialog[open]").waitFor();
}

async function waitClosed(selector, target = page) {
  await target.waitForFunction((selector) => !document.querySelector(selector)?.open, selector);
}

async function jobsCount(number) {
  await page.waitForFunction(({ key, number }) => JSON.parse(localStorage.getItem(key)).jobs.length === number, { key: STORAGE, number });
}

async function importText(body) {
  await nav("intake");
  await page.locator('[data-view-panel="intake"] [data-action="open-import"]').first().click();
  await page.locator("#import-text-tab").click();
  await page.locator("#text-import-body").fill(body);
  await page.locator("#text-import-engine").selectOption("legacy");
  await page.locator("#text-import-form button[type=submit]").click();
  await waitClosed("#import-dialog");
  await page.locator('[data-action="open-bulk-intake"]').waitFor({ state: "visible" });
}

async function openEditor(kind, id = "QA-EDIT") {
  const action = kind === "process" ? "open-process" : "edit-order";
  let button = page.locator(`[data-view-panel="orders"] [data-action="${action}"][data-order-id="${id}"]`).first();
  if (!await button.isVisible()) {
    const detail = page.locator(`[data-action="open-ledger-detail"][data-order-id="${id}"]`).first();
    if (await detail.isVisible()) await detail.click();
    button = page.locator(`[data-action="${action}"][data-order-id="${id}"]`).filter({ visible: true }).first();
  }
  await button.click();
  await page.locator(`#${kind}-dialog[open]`).waitFor();
}

async function edit(kind) {
  if (kind === "process") {
    await page.locator('.stage-edit-row[data-stage-key="welding"] .stage-control[data-status="working"]').click();
  } else {
    await page.locator('#order-form [name="note"]').fill("QA 未保存入力を保持");
  }
}

async function attemptedClose(kind, method) {
  if (method === "x") await page.locator(`#${kind}-dialog .dialog-header [data-action="close-${kind}-dialog"]`).click();
  else if (method === "close") await page.locator(`#${kind}-dialog .dialog-footer [data-action="close-${kind}-dialog"]`).click();
  else if (method === "escape") await page.keyboard.press("Escape");
  else {
    const box = await page.locator(`#${kind}-dialog`).boundingBox();
    assert(box && box.x > 0, "a real backdrop must be available");
    await page.mouse.click(Math.max(1, box.x / 2), 12);
  }
}

async function nativeDateGeometry() {
  const session = await context.newCDPSession(page);
  try {
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const attributes = (node) => Object.fromEntries((node.attributes || []).reduce((pairs, value, index, list) => index % 2 ? pairs : [...pairs, [value, list[index + 1]]], []));
    function nodes(node) { return [node, ...(node.children || []).flatMap(nodes), ...(node.shadowRoots || []).flatMap(nodes)]; }
    const input = nodes(root).find((node) => attributes(node)["data-bulk-field"] === "dueDate");
    assert(input, "date input is present in Chrome DOM");
    const descendants = nodes(input);
    const boxes = {};
    for (const [name, pseudo] of [["year", "-webkit-datetime-edit-year-field"], ["month", "-webkit-datetime-edit-month-field"], ["day", "-webkit-datetime-edit-day-field"], ["picker", "-webkit-calendar-picker-indicator"]]) {
      const node = descendants.find((item) => attributes(item).pseudo === pseudo);
      assert(node, `native ${name} exists`);
      const { model } = await session.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
      boxes[name] = { left: Math.min(model.border[0], model.border[2], model.border[4], model.border[6]), right: Math.max(model.border[0], model.border[2], model.border[4], model.border[6]), width: model.width };
    }
    return boxes;
  } finally { await session.detach(); }
}

await fs.mkdir(OUT, { recursive: true });
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, timezoneId: "Asia/Tokyo", locale: "ja-JP" });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith(`${ORIGIN}/`) || url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto(pageUrl, { waitUntil: "networkidle" });
  await ready();
  base = await storage();

  const BODY = "得意先：QA 評価専用\n品名：QA ケリソンパンチ 18cm 直 2mm\n納期：2026-11-10\n数量：4\n連番：QA-1009-1\n\n品名：QA 鋭匙鉗子 20cm 弯 3mm\n納期：2026-11-12\n数量：8\n連番：QA-1009-2";
  await check("本文の再貼付を一括承認で警告し無断追加を止める", async () => {
    await fixture([]);
    await importText(BODY);
    await openBulk();
    assert.equal(await page.locator("[data-bulk-id]").count(), 2);
    await page.locator("#bulk-intake-submit").click();
    await waitClosed("#bulk-intake-dialog");
    await jobsCount(2);
    await importText(BODY);
    await openBulk();
    await page.locator("#bulk-intake-submit").click();
    await page.locator(".intake-duplicate-warning").first().waitFor();
    assert.equal((await storage()).jobs.length, 2);
    assert.equal(await page.locator(".intake-duplicate-warning").count(), 2);
    const warning = await page.locator(".intake-duplicate-warning").first().innerText();
    assert.match(warning, /既存案件/);
    assert.match(warning, /一致理由/);
    await page.locator(".intake-duplicate-warning details summary").first().click();
    assert.match(await page.locator(".intake-duplicate-warning details").first().innerText(), /QA-1009/);
    await shot("duplicate-bulk-comparison");
    return { jobs: 2, warnings: 2 };
  });

  await check("個別承認の比較と今回の候補を反映しない操作", async () => {
    await fixture([job("QA-EXISTING", { serialNo: "QA-DUPLICATE" })], [candidate("QA-SINGLE-SKIP")]);
    await openSingle("QA-SINGLE-SKIP");
    await page.locator("#intake-form button[type=submit]").click();
    await page.locator("#intake-duplicate-warning .intake-duplicate-warning").waitFor();
    await page.locator("#intake-duplicate-warning details summary").click();
    assert.match(await page.locator("#intake-duplicate-warning").innerText(), /QA-EXISTING/);
    await page.locator('#intake-duplicate-warning [data-action="skip-duplicate-intake"]').click();
    await waitClosed("#intake-dialog");
    const data = await storage();
    assert.equal(data.jobs.length, 1);
    assert.equal(data.intake[0].status, "rejected");
  });

  await check("個別で明示した追加注文を保存し確認履歴を残す", async () => {
    await fixture([job("QA-EXISTING", { serialNo: "QA-DUPLICATE" })], [candidate("QA-SINGLE-ADD")]);
    await openSingle("QA-SINGLE-ADD");
    await page.locator("#intake-form button[type=submit]").click();
    await page.locator('#intake-duplicate-warning [data-action="confirm-separate-intake"]').waitFor();
    await page.locator('#intake-duplicate-warning [data-action="confirm-separate-intake"]').click();
    await waitClosed("#intake-dialog");
    const data = await storage();
    assert.equal(data.jobs.length, 2);
    const log = data.logs.find((entry) => entry.action === "intake.add_separate");
    assert(log && log.detail.matches.some((match) => match.id === "QA-EXISTING"));
  });

  await check("一括の終了案件一致と明示追加の履歴", async () => {
    await fixture([job("QA-COMPLETED", { serialNo: "QA-DUPLICATE", shippingStatus: "shipped", completedAt: new Date().toISOString() })], [candidate("QA-BULK-ADD")]);
    await openBulk();
    await page.locator("#bulk-intake-submit").click();
    await page.locator(".intake-duplicate-warning").waitFor();
    assert.match(await page.locator(".intake-duplicate-warning").innerText(), /終了案件/);
    await page.locator('[data-action="confirm-separate-intake"]').click();
    assert.match(await page.locator(".intake-duplicate-warning").innerText(), /確認済み/);
    await page.locator("#bulk-intake-submit").click();
    await waitClosed("#bulk-intake-dialog");
    assert.equal((await storage()).jobs.length, 2);
    assert((await storage()).logs.some((entry) => entry.action === "intake.add_separate"));
  });

  await check("確認待ちと同一承認バッチの別候補を比較する", async () => {
    await fixture([], [candidate("QA-BATCH-A"), candidate("QA-BATCH-B", { sourceType: "image" })]);
    await openBulk();
    await page.locator("#bulk-intake-submit").click();
    await page.locator(".intake-duplicate-warning").first().waitFor();
    assert.equal((await storage()).jobs.length, 0);
    assert.equal(await page.locator(".intake-duplicate-warning").count(), 2);
    assert.match(await page.locator(".intake-duplicate-warning").first().innerText(), /同じ反映内の別候補/);
    await page.locator("#bulk-intake-all").uncheck();
    await page.locator('[data-bulk-id="QA-BATCH-A"] [data-bulk-select]').check();
    await page.locator("#bulk-intake-submit").click();
    await page.waitForFunction(() => document.querySelector('[data-bulk-id="QA-BATCH-A"] .intake-duplicate-warning')?.textContent.includes("確認待ちの候補"));
    assert.equal((await storage()).jobs.length, 0);
    await shot("duplicate-pending-candidate");
  });

  await check("別経路の外部注文番号と明細番号を照合する", async () => {
    await fixture([job("QA-EXTERNAL", { serialNo: "別の連番", externalOrderNo: "PO-1009", externalLineNo: "3" })], [candidate("QA-EXTERNAL-CANDIDATE", { sourceType: "image", parsed: { serialNo: "", externalOrderNo: "PO-1009", externalLineNo: "3" } })]);
    await openSingle("QA-EXTERNAL-CANDIDATE");
    await page.locator("#intake-form button[type=submit]").click();
    await page.locator(".intake-duplicate-warning").waitFor();
    assert.equal((await storage()).jobs.length, 1);
    await page.locator(".intake-duplicate-warning details summary").click();
    assert.match(await page.locator(".intake-duplicate-warning").innerText(), /PO-1009/);
  });

  await check("異なる得意先の同じ連番と連番なしは通常追加できる", async () => {
    await fixture([job("QA-OTHER-CUSTOMER", { customer: "QA 別の得意先", serialNo: "QA-DUPLICATE" })], [candidate("QA-DIFFERENT"), candidate("QA-NO-SERIAL", { parsed: { serialNo: "" } })]);
    await openBulk();
    await page.locator("#bulk-intake-submit").click();
    await waitClosed("#bulk-intake-dialog");
    assert.equal((await storage()).jobs.length, 3);
    assert.equal((await storage()).logs.filter((entry) => entry.action === "intake.add_separate").length, 0);
  });

  await check("同じ候補の二度押しと再試行は既存案件を返す", async () => {
    const source = candidate("QA-RETRY");
    await fixture([], [source]);
    await openSingle(source.id);
    await page.locator("#intake-form button[type=submit]").dblclick({ delay: 20 });
    await waitClosed("#intake-dialog");
    const first = await storage();
    assert.equal(first.jobs.length, 1);
    await fixture(first.jobs, [source], { logs: first.logs });
    await openBulk();
    await page.locator("#bulk-intake-submit").click();
    await waitClosed("#bulk-intake-dialog");
    const retry = await storage();
    assert.equal(retry.jobs.length, 1);
    assert.equal(retry.jobs[0].id, first.jobs[0].id);
    assert.equal(retry.logs.filter((entry) => entry.action === "intake.add_separate").length, 0);
  });

  await check("別タブが先に登録した同じ注文を承認直前に検出する", async () => {
    await fixture([], [candidate("QA-OTHER-TAB")]);
    await openSingle("QA-OTHER-TAB");
    const second = await context.newPage();
    second.setDefaultTimeout(7000);
    try {
      await second.goto(pageUrl, { waitUntil: "networkidle" });
      await ready(second);
      await second.locator('[data-action="new-order"]').first().click();
      await second.locator('#order-form [name="customer"]').fill("QA 得意先");
      await second.locator('#order-form [name="product"]').fill("QA ケリソンパンチ 18cm 直 2mm");
      await second.locator('#order-form [name="quantity"]').fill("4");
      await second.locator('#order-form [name="serialNo"]').fill("QA-DUPLICATE");
      await second.locator('#order-form [name="dueDate"]').fill("2026-11-10");
      await second.locator("#order-form button[type=submit]").click();
      await waitClosed("#order-dialog", second);
      await page.locator("#intake-form button[type=submit]").click();
      await page.locator("#intake-duplicate-warning .intake-duplicate-warning").waitFor();
      assert.equal((await storage()).jobs.length, 1);
      assert.match(await page.locator("#intake-duplicate-warning").innerText(), /既存案件/);
    } finally { await second.close(); }
  });

  for (const kind of ["process", "order"]) {
    for (const method of ["x", "close", "escape", "backdrop"]) {
      await check(`${kind}: 未保存入力を ${method} で閉じる前に保護する`, async () => {
        await fixture([job("QA-EDIT")]);
        await openEditor(kind);
        await edit(kind);
        await attemptedClose(kind, method);
        await page.locator("#discard-dialog[open]").waitFor();
        assert(await page.locator(`#${kind}-dialog`).evaluate((element) => element.open));
        await page.locator('[data-action="continue-editing"]').click();
        await waitClosed("#discard-dialog");
        if (kind === "process") assert.equal(await page.locator('.stage-edit-row[data-stage-key="welding"] .stage-control.is-selected').getAttribute("data-status"), "working");
        else assert.equal(await page.locator('#order-form [name="note"]').inputValue(), "QA 未保存入力を保持");
        await attemptedClose(kind, method);
        await page.locator("#discard-dialog[open]").waitFor();
        if (method === "x") await shot(`unsaved-${kind}`);
        await page.locator('[data-action="discard-edits"]').click();
        await waitClosed(`#${kind}-dialog`);
        await openEditor(kind);
        if (kind === "process") assert.equal(await page.locator('.stage-edit-row[data-stage-key="welding"] .stage-control.is-selected').getAttribute("data-status"), "not_started");
        else assert.equal(await page.locator('#order-form [name="note"]').inputValue(), "");
        await attemptedClose(kind, "x");
        await waitClosed(`#${kind}-dialog`);
        assert(!await page.locator("#discard-dialog").evaluate((element) => element.open));
      });
    }
    await check(`${kind}: 変更なしと変更を元に戻したときは確認しない`, async () => {
      await fixture([job("QA-EDIT")]);
      await openEditor(kind);
      await attemptedClose(kind, "escape");
      await waitClosed(`#${kind}-dialog`);
      assert(!await page.locator("#discard-dialog").evaluate((element) => element.open));
      await openEditor(kind);
      await edit(kind);
      if (kind === "process") await page.locator('.stage-edit-row[data-stage-key="welding"] .stage-control[data-status="not_started"]').click();
      else await page.locator('#order-form [name="note"]').fill("");
      await attemptedClose(kind, "x");
      await waitClosed(`#${kind}-dialog`);
      assert(!await page.locator("#discard-dialog").evaluate((element) => element.open));
    });
  }

  await check("工程保存を直ちに閉じ保存中再編集と遅い応答の上書きを防ぐ", async () => {
    await fixture([job("QA-EDIT"), job("QA-SECOND")]);
    let release;
    let signal;
    const held = new Promise((resolve) => { release = resolve; });
    const savingStarted = new Promise((resolve) => { signal = resolve; });
    const route = async (request) => {
      const payload = request.request().postDataJSON();
      if (payload?.jobs?.some((entry) => entry.id === "QA-EDIT" && entry.version === 2)) {
        signal();
        await held;
      }
      await request.continue();
    };
    await page.route("**/api/local/product-metadata", route);
    try {
      await openEditor("process");
      await edit("process");
      await page.locator("#process-form button[type=submit]").click();
      assert(!await page.locator("#process-dialog").evaluate((element) => element.open));
      assert(!await page.locator("#discard-dialog").evaluate((element) => element.open));
      await savingStarted;
      await page.locator('[data-action="open-process"][data-order-id="QA-EDIT"]').first().click();
      assert(!await page.locator("#process-dialog").evaluate((element) => element.open), "same job cannot reopen while its save is pending");
      await openEditor("process", "QA-SECOND");
      await edit("process");
      release();
      await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).jobs.find((entry) => entry.id === "QA-EDIT").version === 2, STORAGE);
      assert.equal(await page.locator('#process-form [name="id"]').inputValue(), "QA-SECOND");
      assert.equal(await page.locator('.stage-edit-row[data-stage-key="welding"] .stage-control.is-selected').getAttribute("data-status"), "working");
    } finally {
      release();
      await page.unroute("**/api/local/product-metadata", route);
    }
  });

  for (const size of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
    await check(`一括確認 ${size.width}×${size.height}: 日付・品名全文・備考を読める`, async () => {
      const longProduct = "QA ケリソンパンチ 18cm 直 2mm 長い品名の末尾まで確認できるかを評価する専用追加説明（最終文字）";
      await fixture([], [candidate("QA-LAYOUT", { parsed: { product: longProduct, note: "QA 備考の長い入力\n二行目のメモ" } }), candidate("QA-LAYOUT-2", { parsed: { serialNo: "QA-LAYOUT-2" } })]);
      await page.setViewportSize(size);
      await openBulk();
      const row = page.locator('[data-bulk-id="QA-LAYOUT"]');
      const date = row.locator('[data-bulk-field="dueDate"]');
      await date.scrollIntoViewIfNeeded();
      const metrics = await date.evaluate((element) => {
        const s = getComputedStyle(element);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
        return { width: element.getBoundingClientRect().width, value: element.value, fontSize: s.fontSize, padding: parseFloat(s.paddingLeft) + parseFloat(s.paddingRight), textWidth: ctx.measureText("2026/11/10").width };
      });
      metrics.native = await nativeDateGeometry();
      assert(metrics.width >= 192, `date width was ${metrics.width}px`);
      assert.equal(metrics.value, "2026-11-10");
      assert(metrics.native.day.right < metrics.native.picker.left, `native day and calendar overlap: ${JSON.stringify(metrics.native)}`);
      assert(metrics.native.day.width > 0 && metrics.native.month.width > 0 && metrics.native.year.width > 0, "all date segments are visible");
      assert(parseFloat(metrics.fontSize) >= 15, "readable date font");
      assert.equal(await row.locator("[data-bulk-product-preview]").innerText(), longProduct);
      assert(await row.locator("[data-bulk-product-preview]").isVisible());
      assert.equal(await row.locator('[data-bulk-field="note"]').evaluate((element) => element.tagName), "TEXTAREA");
      const overflow = await row.locator(".bulk-fields").evaluate((element) => element.scrollWidth - element.clientWidth);
      assert(overflow <= 2, `fields overflow by ${overflow}px`);
      await shot(`bulk-${size.width}x${size.height}`);
      await row.locator('[data-bulk-field="note"]').fill("QA 編集内容を閉じても保持\n二行目");
      await page.locator('[data-action="close-bulk-intake"]').click();
      await waitClosed("#bulk-intake-dialog");
      await page.locator('[data-action="open-bulk-intake"]').click();
      assert.equal(await page.locator('[data-bulk-id="QA-LAYOUT"] [data-bulk-field="note"]').inputValue(), "QA 編集内容を閉じても保持\n二行目");
      return metrics;
    });
  }

  await check("一括確認の必須・選択・全選択・反映を保つ", async () => {
    await fixture([], [candidate("QA-REQUIRED", { parsed: { serialNo: "QA-R1" } }), candidate("QA-REQUIRED-2", { parsed: { serialNo: "QA-R2" } })]);
    await openBulk();
    await page.locator('[data-bulk-id="QA-REQUIRED"] [data-bulk-field="customer"]').fill("");
    await page.locator("#bulk-intake-submit").click();
    assert.equal((await storage()).jobs.length, 0);
    assert.equal(await page.locator('[data-bulk-id="QA-REQUIRED"] [data-bulk-field="customer"]').getAttribute("aria-invalid"), "true");
    await page.locator('[data-bulk-id="QA-REQUIRED"] [data-bulk-select]').uncheck();
    await page.locator("#bulk-intake-submit").click();
    await jobsCount(1);
    assert(await page.locator("#bulk-intake-dialog").evaluate((element) => element.open));
    await page.locator("#bulk-intake-all").check();
    await page.locator('[data-bulk-id="QA-REQUIRED"] [data-bulk-field="customer"]').fill("QA 得意先");
    await page.locator("#bulk-intake-submit").click();
    await waitClosed("#bulk-intake-dialog");
    assert.equal((await storage()).jobs.length, 2);
  });

  await check("絞り込み要約を33/23表示に残し解除で並び順と倍率を保つ", async () => {
    await fixture([
      job("QA-FILTER-A", { customer: "QA 対象", serialNo: "FILTER-A" }),
      job("QA-FILTER-B", { customer: "QA 除外", serialNo: "FILTER-B" }),
      job("QA-FILTER-C", { customer: "QA 対象", serialNo: "FILTER-C", shippingStatus: "shipped", completedAt: new Date().toISOString() }),
    ]);
    const details = page.locator('[data-view-panel="orders"] details.ledger-filters');
    await details.locator("summary").click();
    await page.locator("#orders-search").fill("QA 対象");
    await page.waitForFunction(() => document.querySelector("#orders-filter-summary")?.textContent.includes("検索「QA 対象」"));
    await page.locator("#orders-stage-filter").selectOption("welding");
    await page.locator("#orders-attention-filter").selectOption("production");
    await page.locator("#orders-sort").selectOption("customer");
    await details.locator("summary").click();
    const summary = page.locator("#orders-filter-summary");
    assert(await summary.isVisible());
    assert.match(await summary.innerText(), /絞り込み中 1\/2件/);
    assert.match(await summary.innerText(), /QA 対象/);
    assert.match(await summary.innerText(), /工程.*溶接/);
    assert.match(await summary.innerText(), /状況.*製作中/);
    await page.locator('[data-view-panel="orders"] [data-ledger-rows="33"]').click();
    assert(await summary.isVisible());
    await shot("filters-33-collapsed");
    await page.locator('[data-view-panel="orders"] [data-ledger-rows="23"]').click();
    assert(await summary.isVisible());
    await shot("filters-23");
    const before = await page.evaluate(() => localStorage.getItem("production-board-ledger-display-v1"));
    await summary.locator('[data-action="clear-orders-filter"]').click();
    assert(!await summary.isVisible());
    assert.equal(await page.locator("#orders-sort").inputValue(), "customer");
    assert.equal(await page.evaluate(() => localStorage.getItem("production-board-ledger-display-v1")), before);
    assert.equal(await page.locator("#orders-result-count").innerText(), "2件");
    await nav("completed");
    const completed = page.locator("#completed-filter-summary");
    assert.match(await completed.innerText(), /1\/1件/);
    assert.match(await completed.innerText(), /今月/);
    await completed.locator('[data-action="clear-completed-filter"]').click();
    assert(!await completed.isVisible());
    assert.equal(await page.locator("#completed-result-summary").innerText(), "全期間 1件");
  });

  await check("同期で変更のない表とスクロール位置を保持する", async () => {
    await fixture(Array.from({ length: 45 }, (_, index) => job(`QA-SCROLL-${index}`, { serialNo: `SCROLL-${index}`, note: `メモ ${index}` })));
    const scale = page.locator('[data-view-panel="orders"] [data-ledger-scale]');
    await scale.fill("100");
    await scale.dispatchEvent("change");
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => {
      const workspace = document.querySelector("#orders-workspace");
      const scroller = workspace.querySelector(".ledger-viewport");
      const row = workspace.querySelector("tbody tr");
      row.dataset.qaIdentity = "retained";
      if (scroller) scroller.scrollTop = 160;
      return { top: scroller?.scrollTop || 0, selector: scroller?.className || "" };
    });
    assert(before.top > 0, "a real scrolled table is required for this check");
    await page.locator('[data-action="refresh"]').click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({
      retained: Boolean(document.querySelector('#orders-workspace tbody tr[data-qa-identity="retained"]')),
      top: document.querySelector("#orders-workspace .ledger-viewport")?.scrollTop || 0,
    }));
    assert(after.retained, "unchanged table row should retain identity");
    assert.equal(after.top, before.top);
    return { before, after };
  });

  for (const theme of ["light", "dark"]) {
    await check(`取込案内 ${theme}: 実効色の見出しと本文 contrast >= 4.5`, async () => {
      await fixture([]);
      await nav("settings");
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      await nav("intake");
      const colors = await page.locator(".intake-guidance").evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        function rgba(color) {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        }
        const style = getComputedStyle(element);
        return { background: rgba(style.backgroundColor), backgroundCss: style.backgroundColor, heading: rgba(getComputedStyle(element.querySelector("h2")).color), text: rgba(getComputedStyle(element.querySelector("p")).color), headingCss: getComputedStyle(element.querySelector("h2")).color, textCss: getComputedStyle(element.querySelector("p")).color };
      });
      const luminance = (color) => color.slice(0, 3).map((value) => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (color) => { const a = luminance(color), b = luminance(colors.background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
      const measured = { ...colors, headingContrast: contrast(colors.heading), textContrast: contrast(colors.text) };
      assert(measured.headingContrast >= 4.5, `heading contrast was ${measured.headingContrast}`);
      assert(measured.textContrast >= 4.5, `paragraph contrast was ${measured.textContrast}`);
      await shot(`intake-guidance-${theme}`);
      return measured;
    });
  }
} catch (error) {
  results.push({ name: "QA startup", pass: false, error: error.stack || String(error) });
  console.error(error.message);
} finally {
  await browser?.close();
  const passed = results.filter((item) => item.pass).length;
  const failed = results.length - passed;
  const report = { localUrl: pageUrl, isolatedContext: true, productionRequests: false, generatedAt: new Date().toISOString(), passed, failed, runtimeErrors, results, screenshots: shots };
  await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(report, null, 2));
  const lines = ["# 5点修正の実ブラウザー回帰確認", "", `ローカル専用: ${pageUrl}`, "", "Googleへのアクセスと本番書き込みは行っていません。Chrome の専用 context と専用ポートのデモ localStorage を使用しました。", "", `成功 ${passed}件 / 失敗 ${failed}件。`, "", ...results.map((item) => `- ${item.pass ? "成功" : "失敗"}: ${item.name}${item.pass ? "" : ` — ${item.error.split("\n")[0]}`}`), "", "日付の幅・フォントと文字／アイコンの必要幅、品名全文・備考 textarea、閉じた後の編集保持を DOM と実画面で確認しました。guidance の実効 oklch 色は canvas で sRGB に変換して測定しました。", "", "権限別の Google 認証、Sheets 永続化、Apps Script のロック、実機タッチ・実紙印刷はこのローカル QA の対象外です。", "", ...shots.map((file) => `![${file}](${file})`)];
  await fs.writeFile(path.join(OUT, "QA.md"), lines.join("\n"));
  console.log(`QA complete: ${passed} passed / ${failed} failed`);
  if (failed) process.exitCode = 1;
}
