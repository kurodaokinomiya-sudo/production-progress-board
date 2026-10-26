import assert from "node:assert/strict";
import path from "node:path";
import { runBrowserQa, waitForQaReady } from "./browser-runtime.mjs";

const id = "DEMO-001";
const stored = page => page.evaluate(id => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.find(job => job.id === id), id);
async function openOrder(page) {
  await page.locator(`[data-action="edit-order"][data-order-id="${id}"]`).first().click();
  await page.locator("#order-dialog").waitFor({ state: "visible" });
}
async function openProcess(page) {
  await page.locator(`[data-action="open-process"][data-order-id="${id}"][data-stage-key="welding"]`).first().click();
  await page.locator("#process-dialog").waitFor({ state: "visible" });
}
async function submit(page, kind, { failed = false } = {}) {
  await page.locator(`#${kind}-form button[type="submit"]`).click();
  await page.locator(`#${kind}-dialog`).waitFor({ state: "hidden" });
  await page.waitForFunction(({ kind, id, failed }) => {
    const drafts = kind === "order" ? failedOrderDrafts : failedProcessDrafts;
    const pending = kind === "order" ? pendingJobMutations : pendingProcessSaves;
    return !pending.has(id) && (!failed || drafts.has(id));
  }, { kind, id, failed });
}
async function recover(page, kind) {
  const before = await page.evaluate(() => appliedSnapshotRevision);
  await page.locator('[data-action="refresh"]:visible').first().click();
  await page.waitForFunction(before => appliedSnapshotRevision > before && !snapshotLoading, before);
  await page.getByRole("button", { name: "入力内容を開く", exact: true }).last().click();
  await page.locator(`#${kind}-dialog`).waitFor({ state: "visible" });
}
const stage = page => page.locator('#process-form .stage-edit-row[data-stage-key="welding"]');

await runBrowserQa("conflict-recovery", async ({ page: a, context, origin, label, output }) => {
  const b = await context.newPage(); b.setDefaultTimeout(10000);
  await b.goto(`${origin}/${label === "source" ? "src/index.html" : "dist/Index.html"}`); await waitForQaReady(b);
  await openOrder(a); await openOrder(b);
  await a.locator('#order-form [name="note"]').fill("Aの下書き");
  await b.locator('#order-form [name="quantity"]').fill("12");
  await submit(b, "order"); await submit(a, "order", { failed: true });
  await recover(a, "order");
  assert.equal(await a.locator('#order-form [name="note"]').inputValue(), "Aの下書き");
  assert.equal(await a.locator('#order-form [name="quantity"]').inputValue(), "12");
  assert.equal(await a.locator("#order-form [data-recovery-field]").count(), 0);
  await submit(a, "order"); await a.reload(); await waitForQaReady(a);
  assert.equal((await stored(a)).quantity, 12); assert.equal((await stored(a)).note, "Aの下書き");

  await b.reload(); await waitForQaReady(b);
  await openOrder(a); await openOrder(b);
  await a.locator('#order-form [name="note"]').fill("Aの衝突入力");
  await b.locator('#order-form [name="note"]').fill("Bの保存内容");
  await submit(b, "order"); await submit(a, "order", { failed: true });
  await recover(a, "order");
  const choice = a.locator('#order-form [data-recovery-field="note"]');
  const recovery = await a.evaluate(id => { const draft = failedOrderDrafts.get(id); return { kind: draft?.failureKind, base: draft?.baseFields?.note, mine: draft?.values?.note, latest: state.jobs.find(job => job.id === id)?.note, form: document.querySelector('#order-form [name="note"]').value }; }, id);
  assert.equal(recovery.mine, "Aの衝突入力", JSON.stringify(recovery));
  assert.equal(await choice.inputValue(), "");
  assert.equal(await choice.evaluate(element => element === document.activeElement), true);
  await choice.selectOption("mine");
  await a.setViewportSize({ width: 768, height: 1024 });
  assert.ok(await a.locator("#order-dialog .dialog-body").evaluate(element => element.scrollWidth <= element.clientWidth));
  assert.ok(await choice.evaluate(element => element.getBoundingClientRect().height >= 44));
  await a.screenshot({ path: path.join(output, `${label}-order-conflict.png`), fullPage: true });
  await a.setViewportSize({ width: 1280, height: 900 });
  await openOrder(b); await b.locator('#order-form [name="note"]').fill("Bの追加更新"); await submit(b, "order");
  await submit(a, "order", { failed: true });
  await recover(a, "order");
  await a.locator('#order-form [data-recovery-field="note"]').selectOption("latest");
  await submit(a, "order");
  assert.equal((await stored(a)).note, "Bの追加更新");

  await a.reload(); await waitForQaReady(a); await b.reload(); await waitForQaReady(b);
  await a.evaluate(() => {
    const originalSnapshot = api.getSnapshot.bind(api);
    api.getSnapshot = async (...args) => ({ ...await originalSnapshot(...args), access: { role: "worker", canWork: true, canEdit: false } });
    state.access = { role: "worker", canWork: true, canEdit: false }; renderAll();
    globalThis.qaProcessRequests = [];
    const original = api.saveJobProcess.bind(api);
    api.saveJobProcess = async function(payload) {
      qaProcessRequests.push(structuredClone(payload));
      const result = await original(payload);
      if (globalThis.qaLoseProcessReply) { globalThis.qaLoseProcessReply = false; throw new Error("synthetic lost process reply"); }
      return result;
    };
  });
  await openProcess(a); await openProcess(b);
  await stage(a).locator('[data-assignee="幹"]').click();
  await stage(b).locator('[data-status="hold"]').click();
  await submit(b, "process"); await submit(a, "process", { failed: true });
  await recover(a, "process");
  assert.equal(await stage(a).locator('[data-status="hold"]').getAttribute("aria-pressed"), "true");
  assert.equal(await stage(a).locator('[data-assignee="幹"]').getAttribute("aria-pressed"), "true");
  await submit(a, "process");
  let saved = await stored(a);
  assert.equal(saved.stages.welding.status, "hold"); assert.equal(saved.stages.welding.assignee, "幹");
  const payload = await a.evaluate(() => qaProcessRequests.at(-1));
  assert.deepEqual(Object.keys(payload).sort(), ["id", "version", "stages", "shippingStatus", "requestId"].sort());
  assert.equal(saved.note, "Bの追加更新");

  await b.reload(); await waitForQaReady(b);
  await openProcess(a); await openProcess(b);
  await stage(a).locator('[data-assignee="豊"]').click(); await stage(b).locator('[data-assignee="鈴"]').click();
  await submit(b, "process"); await submit(a, "process", { failed: true }); await recover(a, "process");
  await a.locator('#process-form [data-recovery-field="stages.welding.assignee"]').selectOption("mine");
  await submit(a, "process"); assert.equal((await stored(a)).stages.welding.assignee, "豊");

  await openProcess(a); await stage(a).locator('[data-assignee="幹"]').click();
  await a.evaluate(() => { globalThis.qaLoseProcessReply = true; qaProcessRequests.length = 0; });
  await submit(a, "process", { failed: true });
  const committedVersion = (await stored(a)).version;
  await a.getByRole("button", { name: "入力内容を開く", exact: true }).last().click();
  await a.locator("#process-dialog").waitFor({ state: "visible" });
  await submit(a, "process");
  assert.equal((await stored(a)).version, committedVersion);
  assert.equal(await a.evaluate(() => JSON.stringify(qaProcessRequests[0]) === JSON.stringify(qaProcessRequests[1])), true);

  await b.reload(); await waitForQaReady(b); await openOrder(b);
  await b.locator('#order-form [name="note"]').fill("削除前の下書き");
  await a.evaluate(async id => { const job = api.read().jobs.find(job => job.id === id); await api.setJobArchived({ id, version: job.version, archived: true }); }, id);
  await submit(b, "order", { failed: true });
  await b.getByRole("button", { name: "入力内容を開く", exact: true }).last().click();
  assert.equal(await b.locator("#order-dialog").isVisible(), false);
  assert.equal((await stored(b)).archived, true);
  await b.evaluate(() => handleAccessRequired());
  assert.equal(await b.evaluate(() => failedOrderDrafts.size + failedProcessDrafts.size), 0);
  await b.close();

  const c = await context.newPage(); c.setDefaultTimeout(10000);
  await c.goto(`${origin}/${label === "source" ? "src/index.html" : "dist/Index.html"}`); await waitForQaReady(c);
  await c.evaluate(() => {
    globalThis.qaOrderRequests = [];
    const original = api.saveJob.bind(api);
    api.saveJob = async function(payload) {
      qaOrderRequests.push(structuredClone(payload));
      const result = await original(payload);
      if (qaOrderRequests.length === 1) throw new Error("synthetic lost new-order reply");
      return result;
    };
  });
  await c.locator('[data-action="new-order"]').first().click();
  await c.locator('#order-form [name="customer"]').fill("再試行QA");
  await c.locator('#order-form [name="product"]').fill("鋭匙鉗子 21cm 直 4mm");
  await c.locator('#order-form [name="quantity"]').fill("1");
  await c.locator('#order-form [name="serialNo"]').fill("QA-NEW-RETRY");
  await c.locator('#order-form button[type="submit"]').click();
  await c.waitForFunction(() => !pendingJobMutations.size && failedOrderDrafts.size === 1);
  await c.getByRole("button", { name: "入力内容を開く", exact: true }).click();
  await c.locator("#order-dialog").waitFor({ state: "visible" });
  await c.locator('#order-form button[type="submit"]').click();
  await c.waitForFunction(() => !pendingJobMutations.size && failedOrderDrafts.size === 0);
  assert.equal(await c.evaluate(() => JSON.stringify(qaOrderRequests[0]) === JSON.stringify(qaOrderRequests[1])), true);
  await c.reload(); await waitForQaReady(c);
  assert.equal(await c.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.filter(job => job.serialNo === "QA-NEW-RETRY").length), 1);
  await c.close();
});
