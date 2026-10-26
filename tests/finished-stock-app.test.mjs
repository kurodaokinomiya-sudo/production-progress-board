import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all(["finished-stock-orders.js", "finished-stock.js", "materials.js", "intake-duplicates.js", "intake-learning.js", "app.js"]
  .map(file => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")));

function harness() {
  const storage = new Map();
  let queue = Promise.resolve();
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone,
    setTimeout, clearTimeout, crypto: webcrypto, window: { crypto: webcrypto },
    navigator: { locks: { request(name, action) {
      assert.match(name, /intake-approval$/);
      const result = queue.then(action); queue = result.catch(() => {}); return result;
    } } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    fetch: async (url, request) => ({ ok: true, json: async () => url === "/api/local/product-metadata" ? { jobs: JSON.parse(request.body).jobs } : {} }),
  });
  const [orders, stock, materials, duplicates, learning, app] = sources;
  vm.runInContext(`${orders}\n${stock}\n${materials}\n${duplicates}\n${learning}\n${app.slice(0, app.indexOf("async function init()"))}\ndelay = () => Promise.resolve(); globalThis.ui = {api, state, canAccessView, validateFinishedStockPlan, finishedStockQuantitySummary};`, context);
  const { ui } = context;
  ui.state.access = { email: "editor@example.com", role: "editor", canEdit: true };
  const data = ui.api.read(); data.jobs = []; data.intake = []; ui.api.write(data);
  return ui;
}

const job = (extra = {}) => ({ customer: "検証", product: "Tezoe スタンツェ 直・上向", productCode: "26001", quantity: 10,
  stockPlannedQuantity: 5, serialNo: "STOCK-LOT-1", dueDate: "2026-10-30", ...extra });
const product = snapshot => snapshot.products.find(item => item.id === "26001");

async function saveFinishedJob(ui, input) {
  const registered = await ui.api.saveJob({ ...input, requestId: `${input.requestId}-register`, stages: { ...input.stages, finish: { status: "working", assignee: "豊" } } });
  const sent = await ui.api.savePolishingMovement({ action: "send", requestId: `${input.id}-send`, date: "2026-10-01", items: [{ id: registered.id, version: registered.version, quantity: registered.quantity }] });
  const returned = await ui.api.savePolishingMovement({ action: "return", requestId: `${input.id}-return`, date: "2026-10-01", items: [{ id: registered.id, version: sent.jobs[0].version, quantity: registered.quantity }] });
  const ready = returned.jobs[0];
  return ui.api.saveJob({ ...ready, requestId: input.requestId, stages: { ...ready.stages, finish: { status: "done", assignee: "豊" } } });
}

test("planned excess remains separate from actual stock and preserves total manufacturing quantity", async () => {
  const ui = harness();
  const saved = await ui.api.saveJob(job({ requestId: "plan-1", finishedStockEvents: [{ action: "opening", quantity: 100 }] }));
  assert.equal(saved.quantity, 10);
  assert.equal(saved.stockPlannedQuantity, 5);
  assert.equal(saved.finishedStockEvents, undefined);
  const snapshot = await ui.api.getFinishedStock();
  assert.equal(product(snapshot).stockQuantity, 0);
  assert.equal(product(snapshot).plannedQuantity, 5);
  assert.equal(snapshot.plans[0].orderQuantity, 5);
  assert.equal(snapshot.plans[0].dueDate, "2026-10-30");
  assert.equal(ui.finishedStockQuantitySummary(10, 5), "製造10丁 = 今回製造の注文向け5丁 + 在庫補充5丁（Tezoeのみ）");
  for (const invalid of [-1, 11, 0.5, true]) await assert.rejects(ui.api.saveJob(job({ stockPlannedQuantity: invalid })), /整数/);
  await assert.rejects(ui.api.saveJob(job({ productCode: "UNKNOWN" })), /製品番号/);
});

test("actual receipts and job saves share the lock and stock retries do not duplicate lots", async () => {
  const ui = harness();
  const saved = await saveFinishedJob(ui, job({ id: "plan-2", requestId: "plan-2", stages: { finish: { status: "done", assignee: "豊" } } }));
  const opening = { requestId: "opening-1", expectedVersion: 0, productId: "26001", quantity: 2, date: "2026-10-01", note: "棚卸確認" };
  await Promise.all([ui.api.openFinishedStock(opening), ui.api.saveJob(job({ id: "parallel", requestId: "parallel", serialNo: "STOCK-LOT-2", stockPlannedQuantity: 0 }))]);
  const receipt = { requestId: "receipt-1", expectedVersion: 1, jobId: saved.id, jobVersion: saved.version, quantity: 5,
    date: "2026-10-02", productionDate: "2026-10-01", producers: ["豊"], lotNo: "LOT-1" };
  await ui.api.receiveFinishedStock(receipt);
  const snapshot = await ui.api.receiveFinishedStock(receipt);
  assert.equal(snapshot.version, 2);
  assert.equal(product(snapshot).stockQuantity, 7);
  assert.equal(product(snapshot).plannedQuantity, 0);
  assert.equal(ui.api.read().jobs.length, 2);
  assert.equal(snapshot.lots.find(lot => lot.jobId === saved.id).lotNo, "LOT-1");
  await assert.rejects(ui.api.saveJob({ ...saved, stockPlannedQuantity: 4 }), /受領済み/);
  assert.equal((await ui.api.getSnapshot()).finishedStockEvents, undefined);
});

test("intake explicitly confirmed stock plans survive retry and learning never transfers them", async () => {
  const ui = harness();
  await ui.api.openFinishedStock({ requestId: "existing-opening", expectedVersion: 0, productId: "26001", quantity: 2, date: "2026-10-01", note: "新規取込前の開始在庫" });
  const data = ui.api.read();
  data.intake.push({ id: "stock-intake", status: "pending", sourceType: "text", sourceRef: "qa", parsed: job() });
  ui.api.write(data);
  const request = { intakeId: "stock-intake", order: job(), learnProduct: true };
  const saved = await ui.api.approveIntake(request);
  assert.equal(saved.stockPlannedQuantity, 5);
  assert.equal((await ui.api.approveIntake(request)).id, saved.id);
  assert.equal((await ui.api.getFinishedStock()).plans.length, 1);
  const projectedOrder = (await ui.api.getFinishedStock()).orders.find(order => order.jobId === saved.id);
  assert.equal(projectedOrder.quantity, 5);
  assert.equal(projectedOrder.allocatedQuantity, 2);
  assert.equal(projectedOrder.shortageQuantity, 3);
  const rules = await ui.api.getIntakeLearningRules();
  assert.equal(JSON.stringify(rules).includes("stockPlannedQuantity"), false);
});

test("workers, viewers, and revoked accounts cannot read or mutate finished stock", async () => {
  const ui = harness();
  for (const role of ["worker", "viewer"]) {
    ui.state.access = { role, canEdit: false };
    assert.equal(ui.canAccessView("finishedStock"), false);
    for (const name of ["getFinishedStock", "openFinishedStock", "receiveFinishedStock", "shipFinishedStock", "reverseFinishedStock", "saveFinishedStockSchedule"]) {
      await assert.rejects(ui.api[name]({}), /編集権限/);
    }
  }
  ui.state.access = { role: "editor", canEdit: true }; ui.state.accessRevoked = true;
  await assert.rejects(ui.api.getFinishedStock(), /編集権限/);
  await assert.rejects(ui.api.saveFinishedStockSchedule({}), /編集権限/);
});

test("stock schedule retries once, fixes actual order quantity, and never changes manufacturing quantity", async () => {
  const ui = harness();
  const saved = await ui.api.saveJob(job({ id: "schedule-order", requestId: "schedule-job" }));
  await ui.api.openFinishedStock({ requestId: "schedule-opening", expectedVersion: 0, productId: "26001", quantity: 2, date: "2026-10-01", note: "確定した現物" });
  const schedule = { requestId: "schedule-1", expectedVersion: 1, jobId: saved.id, jobVersion: saved.version,
    orderQuantity: 5, stockQuantity: 2, shipmentMode: "split", shipDate: "", completionDate: "", note: "在庫2丁を先に出荷予定" };
  const first = await ui.api.saveFinishedStockSchedule(schedule);
  const retried = await ui.api.saveFinishedStockSchedule(schedule);
  assert.equal(first.version, 2); assert.equal(retried.version, 2);
  assert.equal(retried.history.filter(event => event.requestId === schedule.requestId).length, 1);
  assert.equal(ui.api.read().jobs.find(entry => entry.id === saved.id).quantity, 10);
  const updated = await ui.api.saveJob({ ...saved, quantity: 8, requestId: "manual-production-adjustment" });
  const order = (await ui.api.getFinishedStock()).orders.find(entry => entry.jobId === saved.id);
  assert.equal(updated.quantity, 8); assert.equal(updated.stockPlannedQuantity, 5);
  assert.equal(order.hasSchedule, true); assert.equal(order.quantity, 5);
  assert.equal(order.allocatedQuantity, 2); assert.equal(order.shortageQuantity, 3);
});

test("direct shipment is blocked while stock allocation remains and allowed after an explicit zero stock schedule", async () => {
  const ui = harness();
  const saved = await saveFinishedJob(ui, job({ id: "shipping-order", requestId: "shipping-job", stockPlannedQuantity: 0, quantity: 5, shippingStatus: "not_ready",
    stages: { finish: { status: "done", assignee: "豊" } } }));
  await ui.api.openFinishedStock({ requestId: "shipping-opening", expectedVersion: 0, productId: "26001", quantity: 2, date: "2026-10-01", note: "確定した現物" });
  await assert.rejects(ui.api.saveJob({ ...saved, shippingStatus: "shipped", requestId: "blocked-shipping" }), /在庫からの出荷予定分が残っています/);
  assert.equal(ui.api.read().jobs.find(entry => entry.id === saved.id).shippingStatus, "not_ready");
  await ui.api.saveFinishedStockSchedule({ requestId: "direct-only", expectedVersion: 1, jobId: saved.id, jobVersion: saved.version,
    orderQuantity: 5, stockQuantity: 0, shipmentMode: "together", shipDate: "", completionDate: "", note: "在庫は使わず製造分を出荷" });
  const shipped = await ui.api.saveJob({ ...saved, shippingStatus: "shipped", requestId: "direct-shipping" });
  assert.equal(shipped.shippingStatus, "shipped");
  assert.equal(ui.api.read().finishedStockEvents.filter(event => event.action === "ship").length, 0);
  assert.equal(product(await ui.api.getFinishedStock()).stockQuantity, 2);
});

test("linked stock shipment clears its allocation and preserves trace without changing manufacturing quantity", async () => {
  const ui = harness();
  const saved = await saveFinishedJob(ui, job({ id: "linked-order", requestId: "linked-job", stockPlannedQuantity: 0, quantity: 5,
    shippingStatus: "not_ready", stages: { finish: { status: "done", assignee: "豊" } } }));
  await ui.api.openFinishedStock({ requestId: "linked-opening", expectedVersion: 0, productId: "26001", quantity: 2, date: "2026-10-01", note: "現物確認", lotNo: "LINKED-LOT" });
  const request = { requestId: "linked-shipping", expectedVersion: 1, orderJobId: saved.id, jobVersion: saved.version,
    productId: "26001", quantity: 2, date: "2026-10-02", purpose: "sale", note: "受注分を先に出荷" };
  const snapshot = await ui.api.shipFinishedStock(request);
  assert.equal((await ui.api.shipFinishedStock(request)).version, snapshot.version);
  const order = snapshot.orders.find(entry => entry.jobId === saved.id);
  assert.equal(order.allocatedQuantity, 0); assert.equal(order.shippedQuantity, 2); assert.equal(order.remainingQuantity, 3);
  assert.equal(snapshot.history.find(event => event.requestId === request.requestId).allocations[0].lotNo, "LINKED-LOT");
  assert.equal(ui.api.read().jobs.find(entry => entry.id === saved.id).quantity, 5);
  assert.equal((await ui.api.saveJob({ ...saved, shippingStatus: "shipped", requestId: "linked-production-shipping" })).shippingStatus, "shipped");
});

test("stock-only customers replenish the whole manufacturing quantity without rewriting saved fields", async () => {
  for (const customer of ["在庫", "在庫用"]) {
    const ui = harness();
    const saved = await saveFinishedJob(ui, job({ id: `stock-only-${customer}`, requestId: `stock-only-${customer}`, customer,
      stockPlannedQuantity: 0, quantity: 10, stages: { finish: { status: "done", assignee: "豊" } } }));
    const before = await ui.api.getFinishedStock();
    assert.equal(before.orders.some(order => order.jobId === saved.id), false);
    assert.equal(before.plans.find(plan => plan.jobId === saved.id).quantity, 10);
    assert.equal(before.productions.find(production => production.jobId === saved.id).quantity, 10);
    assert.equal(product(before).orderQuantity, 0);
    assert.equal(ui.finishedStockQuantitySummary(10, 0, customer), `製造10丁は全数を在庫補充として扱います（得意先：${customer}）`);
    const received = await ui.api.receiveFinishedStock({ requestId: `receive-${customer}`, expectedVersion: 0,
      jobId: saved.id, jobVersion: saved.version, quantity: 3, date: "2026-10-01", productionDate: "2026-10-01", producers: ["豊"] });
    assert.equal(product(received).stockQuantity, 3);
    assert.equal(received.plans.find(plan => plan.jobId === saved.id).quantity, 7);
    assert.equal(received.productions.find(production => production.jobId === saved.id).quantity, 7);
    assert.equal(received.orders.some(order => order.jobId === saved.id), false);
    const raw = ui.api.read().jobs.find(entry => entry.id === saved.id);
    assert.equal(raw.quantity, 10); assert.equal(raw.stockPlannedQuantity, 0); assert.equal(raw.customer, customer);
  }
  const ui = harness();
  assert.equal(ui.finishedStockQuantitySummary(10, 5, "顧客向け在庫用"), "製造10丁 = 今回製造の注文向け5丁 + 在庫補充5丁（Tezoeのみ）");
  assert.equal(ui.finishedStockQuantitySummary(10, 5, "検証"), "製造10丁 = 今回製造の注文向け5丁 + 在庫補充5丁（Tezoeのみ）");
});
