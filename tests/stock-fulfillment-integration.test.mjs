import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";

async function mock() {
  const files = ["finished-stock-orders.js", "finished-stock.js", "materials.js", "intake-duplicates.js", "intake-learning.js", "app.js"];
  const sources = await Promise.all(files.map(file => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")));
  const storage = new Map();
  const c = vm.createContext({ Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone,
    setTimeout, clearTimeout, crypto: webcrypto, window: { crypto: webcrypto }, navigator: {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    fetch: async (url, request) => ({ ok: true, json: async () => url === "/api/local/product-metadata" ? { jobs: JSON.parse(request.body).jobs } : {} }),
  });
  vm.runInContext(`${sources.slice(0, 5).join("\n")}\n${sources[5].slice(0, sources[5].indexOf("async function init()"))}\ndelay = () => Promise.resolve(); globalThis.ui = { api, state };`, c);
  const data = c.ui.api.read(); data.jobs = []; data.intake = []; data.finishedStockEvents = []; c.ui.api.write(data);
  const role = value => { c.ui.state.access = { role: value, canEdit: ["owner", "admin", "editor"].includes(value) }; };
  role("editor");
  return { api: c.ui.api, jobs: () => c.ui.api.read().jobs, role };
}

async function server() {
  const h = await sheetsFixture(["src/finished-stock-orders.js", "src/finished-stock.js", "src/materials.js", "apps-script/Materials.gs", "apps-script/FinishedStock.gs", "apps-script/Polishing.gs"]);
  h.context.syncPolishingMirrorBestEffort_ = () => "";
  let currentRole = "editor";
  h.context.requireEditorAccess_ = () => {
    if (!["owner", "admin", "editor"].includes(currentRole)) throw new Error("EDITOR_REQUIRED: 編集権限が必要です。");
    return { role: currentRole, email: "fixture@example.invalid", canEdit: true };
  };
  h.context.requireWorkerAccess_ = () => {
    if (!["owner", "admin", "editor", "worker"].includes(currentRole)) throw new Error("WORKER_REQUIRED: 工程を更新する権限が必要です。");
    return { role: currentRole, email: "fixture@example.invalid", canEdit: currentRole !== "worker", canWork: true };
  };
  return { ...h, api: h.context, jobs: () => h.context.readJobs_(), role: value => { currentRole = value; } };
}

async function setup(h) {
  const a = h.api;
  const stages = Object.fromEntries(["welding", "base", "grinding", "heat", "finish"].map(key => [key, { status: "not_started", assignee: "" }]));
  let order = await a.saveJob({ customer: "検証受注", product: "Tezoe スタンツェ 直・上向", productCode: "26001", quantity: 5, stockPlannedQuantity: 0, serialNo: "FULFILLMENT", requestId: "order", stages });
  await a.openFinishedStock({ requestId: "opening", expectedVersion: 0, productId: "26001", quantity: 5, date: "2026-10-01", note: "合成fixture" });
  await a.saveFinishedStockSchedule({ requestId: "schedule", expectedVersion: 1, jobId: order.id, jobVersion: order.version, orderQuantity: 5, stockQuantity: 5, shipmentMode: "split", shipDate: "", completionDate: "" });
  order = await a.saveJob({ ...order, quantity: 0, requestId: "zero" });
  const ship = (quantity, date, requestId, expectedVersion) => a.shipFinishedStock({ requestId, expectedVersion, productId: "26001", orderJobId: order.id, jobVersion: order.version, quantity, date, purpose: "sale" });
  return { order, ship };
}

for (const [name, factory] of [["server", server], ["MockApi", mock]]) {
  test(`${name}: manual stock fulfillment preserves manufacturing, uses last shipment day, and cancellation reopens exactly once`, async () => {
    const h = await factory(), a = h.api, { order, ship } = await setup(h);
    const completion = { ...order, shippingStatus: "shipped", requestId: "fulfill" };
    await ship(2, "2026-10-01", "ship-first", 2);
    await assert.rejects(async () => a.saveJob(completion), /研磨|最終仕上げ|出荷予定/);
    const shipped = await ship(3, "2026-10-02", "ship-last", 3);
    for (const role of ["worker", "viewer", "revoked"]) {
      h.role(role);
      await assert.rejects(async () => a.saveJob(completion), /権限|EDITOR_REQUIRED/);
    }
    h.role("editor");
    await assert.rejects(async () => a.saveJob({ ...completion, stages: { ...order.stages, finish: { status: "done", assignee: "" } } }), /最終仕上げ/);
    const saved = await a.saveJob(completion);
    assert.equal(saved.completionKind, "stock_fulfillment");
    assert.equal(saved.shippingStatus, "shipped");
    assert.equal(saved.quantity, 0);
    assert.equal(saved.stages.finish.status, order.stages.finish.status);
    assert.equal(saved.completedAt, "2026-10-01T15:00:00.000Z");
    assert.equal((await a.saveJob(completion)).version, saved.version, "lost response retries the same request without another completion");
    assert.equal((await a.getFinishedStock()).products.find(p => p.id === "26001").stockQuantity, 0);
    assert.equal((await a.getFinishedStock()).orders.length, 0);
    const firstShip = shipped.history.find(e => e.requestId === "ship-first");
    const reversal = { requestId: "reverse", expectedVersion: shipped.version, eventId: firstShip.id, date: "2026-10-03", note: "合成取消" };
    const reversed = await a.reverseFinishedStock(reversal);
    const reopened = h.jobs().find(j => j.id === order.id);
    assert.equal(reopened.shippingStatus, "not_ready");
    assert.equal(reopened.completionKind, "");
    assert.equal(reopened.completedAt, "");
    assert.equal(reopened.version, saved.version + 1);
    assert.equal(reversed.orders[0].remainingQuantity, 2);
    assert.equal(reversed.products.find(p => p.id === "26001").stockQuantity, 2);
    await a.reverseFinishedStock(reversal);
    assert.equal(h.jobs().find(j => j.id === order.id).version, reopened.version);
    await assert.rejects(async () => a.saveJob({ ...reopened, shippingStatus: "shipped", requestId: "too-soon" }), /研磨|最終仕上げ|出荷予定/);
    await a.shipFinishedStock({ requestId: "replacement", expectedVersion: reversed.version, productId: "26001", orderJobId: reopened.id, jobVersion: reopened.version, quantity: 2, date: "2026-10-03", purpose: "sale" });
    const fulfilledAgain = await a.saveJob({ ...reopened, shippingStatus: "shipped", requestId: "fulfill-again" });
    assert.equal(fulfilledAgain.completedAt, "2026-10-02T15:00:00.000Z");
    assert.equal(fulfilledAgain.stages.finish.status, order.stages.finish.status);
  });
}

test("server repairs automatic reopening after reversal committed but its job write failed", async () => {
  const h = await server(), a = h.api, { order, ship } = await setup(h);
  const shipped = await ship(5, "2026-10-02", "ship-all", 2);
  await a.saveJob({ ...order, shippingStatus: "shipped", requestId: "fulfill" });
  h.state.beforeWrite = operation => { if (operation.name === a.APP.SHEETS.JOBS) { h.state.beforeWrite = null; throw new Error("reopen write failed"); } };
  const request = { requestId: "reverse", expectedVersion: shipped.version, eventId: shipped.history.find(e => e.requestId === "ship-all").id, date: "2026-10-03", note: "訂正" };
  await assert.rejects(async () => a.reverseFinishedStock(request), /reopen write failed/);
  const repaired = await a.getFinishedStock();
  assert.equal(h.jobs()[0].shippingStatus, "not_ready");
  assert.equal(repaired.orders[0].remainingQuantity, 5);
  assert.equal(repaired.products.find(p => p.id === "26001").stockQuantity, 5);
  await a.reverseFinishedStock(request);
  assert.equal((await a.getFinishedStock()).products.find(p => p.id === "26001").stockQuantity, 5);
});

async function manufacturingReady(h, { quantity = 3, stockPlannedQuantity = 0, initialStock = 0, scheduledStock = 2, customer = "検証受注" } = {}) {
  const a = h.api;
  let job = await a.saveJob({ customer, product: "Tezoe スタンツェ 直・上向", productCode: "26001", quantity, stockPlannedQuantity, serialNo: "MIXED", requestId: "mixed-order", stages: { finish: { status: "working", assignee: "豊" } } });
  if (initialStock) await a.openFinishedStock({ requestId: "mixed-opening", expectedVersion: 0, productId: "26001", quantity: initialStock, date: "2026-10-01", note: "合成在庫" });
  if (scheduledStock !== null) await a.saveFinishedStockSchedule({ requestId: "mixed-schedule", expectedVersion: (await a.getFinishedStock()).version, jobId: job.id, jobVersion: job.version, orderQuantity: 5, stockQuantity: scheduledStock, shipmentMode: "split", shipDate: "2026-10-02" });
  const sent = await a.savePolishingMovement({ action: "send", requestId: "mixed-send", date: "2026-10-01", items: [{ id: job.id, version: job.version, quantity }] });
  const returned = await a.savePolishingMovement({ action: "return", requestId: "mixed-return", date: "2026-10-02", items: [{ id: job.id, version: sent.jobs[0].version, quantity }] });
  job = returned.jobs[0];
  return a.saveJob({ ...job, requestId: "mixed-finish", stages: { ...job.stages, finish: { status: "done", assignee: "豊" } } });
}

async function shipMixed(a, job, quantity) {
  return a.shipFinishedStock({ requestId: "mixed-stock-ship", expectedVersion: (await a.getFinishedStock()).version, productId: "26001", orderJobId: job.id, jobVersion: job.version, quantity, date: "2026-10-02", purpose: "sale" });
}

for (const [name, factory] of [["server", server], ["MockApi", mock]]) {
  for (const [initialStock, shippedQuantity] of [[0, 0], [1, 1], [2, 0], [2, 2]]) {
    test(`${name}: order5/manufacture3/stock target2 with stock ${initialStock} and shipped ${shippedQuantity}`, async () => {
      const h = await factory(), a = h.api;
      const job = await manufacturingReady(h, { initialStock });
      if (shippedQuantity) await shipMixed(a, job, shippedQuantity);
      const before = await a.getFinishedStock(), order = before.orders.find(order => order.jobId === job.id);
      assert.equal(order.stockTargetQuantity, 2 - shippedQuantity);
      assert.equal(job.polishing.sentQuantity, 3); assert.equal(job.polishing.returnedQuantity, 3);
      assert.equal(job.stages.finish.status, "done");
      const complete = { ...job, shippingStatus: "shipped", requestId: "mixed-complete" };
      if (shippedQuantity < 2) {
        await assert.rejects(async () => a.saveJob(complete), /在庫からの出荷予定分が残っています/);
        await assert.rejects(async () => a.saveJobProcess({ id: job.id, version: job.version, stages: job.stages, shippingStatus: "shipped", requestId: "mixed-process-complete" }), /在庫からの出荷予定分が残っています/);
        assert.notEqual(h.jobs().find(entry => entry.id === job.id).shippingStatus, "shipped");
        assert.equal((await a.getFinishedStock()).orders.find(order => order.jobId === job.id).stockTargetQuantity, 2 - shippedQuantity);
      } else {
        const saved = await a.saveJob(complete);
        assert.equal(saved.shippingStatus, "shipped");
        assert.equal((await a.saveJob(complete)).version, saved.version);
        assert.equal((await a.getFinishedStock()).orders.some(order => order.jobId === job.id), false);
      }
      const after = await a.getFinishedStock();
      assert.equal(after.version, before.version, "completion never records an extra inventory movement");
      assert.equal(after.products.find(product => product.id === "26001").stockQuantity, initialStock - shippedQuantity);
    });
  }

  for (const options of [
    { quantity: 5, scheduledStock: 0, initialStock: 2 },
    { quantity: 5, scheduledStock: null },
    { quantity: 10, stockPlannedQuantity: 5, scheduledStock: null },
    { quantity: 10, stockPlannedQuantity: 5, scheduledStock: 0 },
    { quantity: 5, customer: "在庫用", scheduledStock: null },
  ]) {
    test(`${name}: direct manufacturing completion preserves ${JSON.stringify(options)}`, async () => {
      const h = await factory(), a = h.api, job = await manufacturingReady(h, options);
      const before = await a.getFinishedStock();
      const saved = await a.saveJob({ ...job, shippingStatus: "shipped", requestId: "direct-complete" });
      assert.equal(saved.shippingStatus, "shipped");
      assert.equal(saved.quantity, options.quantity);
      const after = await a.getFinishedStock();
      assert.equal(after.version, before.version);
      assert.equal(after.orders.some(order => order.jobId === job.id), false);
      if (options.stockPlannedQuantity === 5 || options.customer === "在庫用") {
        assert.equal(after.plans.find(plan => plan.jobId === job.id).quantity, 5, "unreceived replenishment stays actionable after customer completion");
        const received = await a.receiveFinishedStock({ requestId: "replenish-after-completion", expectedVersion: after.version, jobId: saved.id, jobVersion: saved.version, quantity: 5, date: "2026-10-02", productionDate: "2026-10-02", producers: ["豊"] });
        assert.equal(received.products.find(product => product.id === "26001").stockQuantity, 5);
        assert.equal(received.lots.find(lot => lot.jobId === job.id).quantity, 5);
      }
    });
  }

  test(`${name}: completion checks the submitted customer manufacturing quantity against a fixed order`, async () => {
    const h = await factory(), a = h.api, job = await manufacturingReady(h, { quantity: 5, scheduledStock: 0 });
    await assert.rejects(async () => a.saveJob({ ...job, stockPlannedQuantity: 2, shippingStatus: "shipped", requestId: "reduce-customer-production" }), /注文数量.*製造|製造.*不足/);
    assert.equal(h.jobs().find(entry => entry.id === job.id).stockPlannedQuantity, 0);
    assert.notEqual(h.jobs().find(entry => entry.id === job.id).shippingStatus, "shipped");
  });

  test(`${name}: mixed completion/reopen retains role, version and cancellation checks`, async () => {
    const h = await factory(), a = h.api, job = await manufacturingReady(h, { initialStock: 2 });
    const shipped = await shipMixed(a, job, 2);
    const completion = { ...job, shippingStatus: "shipped", requestId: "mixed-role-complete" };
    for (const role of ["worker", "viewer", "revoked"]) {
      h.role(role);
      await assert.rejects(async () => a.saveJob(completion), /権限|EDITOR_REQUIRED/);
      await assert.rejects(async () => a.saveJobProcess({ id: job.id, version: job.version, stages: job.stages, shippingStatus: "shipped", requestId: `process-${role}` }), /権限|REQUIRED/);
    }
    h.role("editor");
    const saved = await a.saveJob(completion);
    await assert.rejects(async () => a.saveJob({ ...job, requestId: "stale-completion", shippingStatus: "shipped" }), /別の端末/);
    for (const role of ["worker", "viewer", "revoked"]) {
      h.role(role);
      await assert.rejects(async () => a.saveJob({ ...saved, shippingStatus: "waiting", requestId: `reopen-${role}` }), /権限|EDITOR_REQUIRED/);
    }
    h.role("editor");
    const reopened = await a.saveJob({ ...saved, shippingStatus: "waiting", requestId: "mixed-reopen" });
    const reversal = { requestId: "mixed-reverse", expectedVersion: shipped.version, eventId: shipped.history.find(event => event.requestId === "mixed-stock-ship").id, date: "2026-10-03", note: "合成取消" };
    await a.reverseFinishedStock(reversal); await a.reverseFinishedStock(reversal);
    assert.equal((await a.getFinishedStock()).orders.find(order => order.jobId === job.id).stockTargetQuantity, 2);
    await assert.rejects(async () => a.saveJob({ ...reopened, shippingStatus: "shipped", requestId: "after-cancel-complete" }), /在庫からの出荷予定分が残っています/);
    assert.equal((await a.getFinishedStock()).products.find(product => product.id === "26001").stockQuantity, 2);
  });
}
