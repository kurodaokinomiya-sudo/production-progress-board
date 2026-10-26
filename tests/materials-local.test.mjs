import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [materials, duplicates, learning, app] = await Promise.all([
  "src/materials.js", "src/intake-duplicates.js", "src/intake-learning.js", "src/app.js",
].map(file => readFile(new URL(`../${file}`, import.meta.url), "utf8")));

function harness() {
  const storage = new Map();
  let queue = Promise.resolve();
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone,
    setTimeout, clearTimeout, crypto: webcrypto, window: { crypto: webcrypto },
    navigator: { locks: { request(name, action) { assert.match(name, /intake-approval$/); const result = queue.then(action); queue = result.catch(() => {}); return result; } } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    fetch: async (url, request) => ({ ok: true, json: async () => url === "/api/local/product-metadata" ? { jobs: JSON.parse(request.body).jobs } : {} }),
  });
  vm.runInContext(`${materials}\n${duplicates}\n${learning}\n${app.slice(0, app.indexOf("async function init()"))}\ndelay = () => Promise.resolve(); globalThis.ui = {api, state, canAccessView};`, context);
  const { ui } = context;
  ui.state.access = { email: "editor@example.com", role: "editor", canEdit: true };
  const data = ui.api.read();
  data.jobs = [];
  data.intake = [];
  ui.api.write(data);
  return ui;
}

const order = (extra = {}) => ({ customer: "松井", product: "慈大式 彫骨器（直・上向）", productCode: "CK001", specShape: "直・上向", quantity: 3, serialNo: "MATERIAL-LOCAL-1", ...extra });
const stock = (snapshot, id) => snapshot.materials.find(material => material.id === id);

test("local confirmed orders, shared Tezoe stock and dedicated stock survive API reload", async () => {
  const ui = harness();
  assert.equal(stock(await ui.api.getMaterialInventory(), "CK001").stockQuantity, 28);
  const input = order({ requestId: "manual-1" });
  const saved = await ui.api.saveJob(input);
  const retry = await ui.api.saveJob(input);
  assert.equal(retry.id, saved.id);
  assert.equal(ui.api.read().jobs.length, 1);
  await assert.rejects(ui.api.saveJob({ ...input, quantity: 4 }), /リクエストID/);
  await ui.api.saveJob(order({ product: "Tezoe スタンツェ（直・上向）", productCode: "26001", quantity: 2, requestId: "tezoe-shared" }));
  await ui.api.saveJob(order({ product: "Tezoe スタンツェ（直・下向）", productCode: "26002", specShape: "直・下向", quantity: 2, requestId: "tezoe-dedicated" }));
  const snapshot = await ui.api.getSnapshot();
  assert.equal(stock(snapshot.materialInventory, "CK001").stockQuantity, 23);
  assert.equal(stock(snapshot.materialInventory, "CK002").stockQuantity, 42);
  assert.equal(stock(snapshot.materialInventory, "TEZOE26002").stockQuantity, -1);
  assert.equal(snapshot.materialInventory.history.filter(event => event.action === "use").length, 3);
});

test("MockApi excludes weak-bend-down variants without changing stock or persisted material history", async () => {
  const ui = harness();
  const weakDownOrders = [
    order({ product: "慈大式 彫骨器", productCode: "CK012", specShape: "", quantity: 4, serialNo: "CK012" }),
    order({ product: "Tezoe スタンツェ", productCode: "26012", specShape: "", quantity: 5, serialNo: "26012" }),
    order({ product: "慈大式 彫骨器 弱弯・下向", productCode: "", specShape: "弱弯・下向", quantity: 6, serialNo: "NO-CODE" }),
  ];
  for (const [index, input] of weakDownOrders.entries()) {
    const saved = await ui.api.saveJob({ ...input, requestId: `excluded-${index}` });
    assert.deepEqual(JSON.parse(JSON.stringify(saved.materials.allocation)), [], input.serialNo);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.materials.history)), [], input.serialNo);
  }
  let snapshot = await ui.api.getMaterialInventory();
  assert.deepEqual(snapshot.materials.map(material => material.stockQuantity), [28, 12, 42, 1, 0, 0]);
  assert.equal(snapshot.unresolved.length, 0);
  assert.equal(snapshot.history.filter(event => event.action === "use" || event.action === "release").length, 0);

  const priorMaterialState = {
    version: 1,
    baseline: { allocation: [], at: "2026-10-20T00:00:00.000Z" },
    allocation: [],
    history: [
      { id: "prior-use", action: "use", materialId: "CK001", quantity: 2, at: "2026-10-20T00:00:00.000Z", date: "2026-10-20", actor: "", jobId: "legacy-weak-down", product: "慈大式 彫骨器", customer: "松井", serialNo: "LEGACY", orderId: "", note: "既存の材料記録" },
      { id: "prior-release", action: "release", materialId: "CK001", quantity: 2, at: "2026-10-20T01:00:00.000Z", date: "2026-10-20", actor: "", jobId: "legacy-weak-down", product: "慈大式 彫骨器", customer: "松井", serialNo: "LEGACY", orderId: "", note: "既存の訂正記録" },
    ],
    requests: [],
  };
  const legacy = {
    id: "legacy-weak-down", ...weakDownOrders[0], quantity: 4, version: 1,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", archived: false,
    shippingStatus: "not_ready", completedAt: "", stages: { finish: { status: "working", assignee: "" } },
    materials: priorMaterialState,
  };
  const data = ui.api.read();
  data.jobs.push(legacy);
  ui.api.write(data);
  snapshot = await ui.api.getMaterialInventory();
  const beforeHistory = JSON.parse(JSON.stringify(snapshot.history.filter(event => event.jobId === legacy.id)));
  assert.equal(snapshot.unresolved.some(item => item.id === legacy.id), false);

  const edited = await ui.api.saveJob({ ...legacy, quantity: 7, requestId: "legacy-excluded-quantity" });
  assert.equal(edited.quantity, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(edited.materials.history)), priorMaterialState.history);
  snapshot = await ui.api.getMaterialInventory();
  assert.equal(snapshot.unresolved.some(item => item.id === legacy.id), false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.history.filter(event => event.jobId === legacy.id))), beforeHistory);
  assert.deepEqual(snapshot.materials.map(material => material.stockQuantity), [28, 12, 42, 1, 0, 0]);
});

test("local receipts and order saves share a lock and retain both mutations", async () => {
  const ui = harness();
  const purchase = await ui.api.saveMaterialOrder({ requestId: "purchase", materialId: "CK001", orderDate: "2026-10-20", quantity: 10, expectedDate: "2026-10-30", note: "分納" });
  const receipt = { requestId: "receipt", orderId: purchase.orders[0].id, date: "2026-10-21", quantity: 4, note: "" };
  await Promise.all([ui.api.saveJob(order({ requestId: "job" })), ui.api.receiveMaterialOrder(receipt)]);
  const snapshot = await ui.api.receiveMaterialOrder(receipt);
  assert.equal(stock(snapshot, "CK001").stockQuantity, 29);
  assert.equal(stock(snapshot, "CK001").onOrderQuantity, 6);
  assert.equal(snapshot.orders[0].receivedQuantity, 4);
  assert.equal(snapshot.history.filter(event => event.action === "receive").length, 1);
  await assert.rejects(ui.api.receiveMaterialOrder({ ...receipt, requestId: "too-many", quantity: 7 }), /発注残/);
  await ui.api.cancelMaterialOrder({ requestId: "cancel", orderId: receipt.orderId, date: "2026-10-21", note: "残数の発注取消" });
  const adjusted = await ui.api.adjustMaterialStock({ requestId: "adjust", materialId: "CK001", date: "2026-10-21", quantity: -1, note: "棚卸差異" });
  assert.equal(stock(adjusted, "CK001").stockQuantity, 28);
  assert.equal(stock(adjusted, "CK001").onOrderQuantity, 0);
});

test("local intake candidates deduct on approval only and retry the same confirmed job", async () => {
  const ui = harness();
  const input = order();
  const data = ui.api.read();
  data.intake.push({ id: "intake-material", status: "pending", sourceType: "text", sourceRef: "qa", parsed: input });
  ui.api.write(data);
  assert.equal(stock(await ui.api.getMaterialInventory(), "CK001").stockQuantity, 28);
  const request = { intakeId: "intake-material", order: input };
  const saved = await ui.api.approveIntake(request);
  assert.equal((await ui.api.approveIntake(request)).id, saved.id);
  const snapshot = await ui.api.getMaterialInventory();
  assert.equal(stock(snapshot, "CK001").stockQuantity, 25);
  assert.equal(snapshot.history.filter(event => event.action === "use").length, 1);
});

test("materials view and local material RPCs are hidden from worker and viewer roles", async () => {
  const ui = harness();
  for (const role of ["worker", "viewer"]) {
    ui.state.access = { role, canEdit: false };
    assert.equal(ui.canAccessView("materials"), false);
    await assert.rejects(ui.api.getMaterialInventory(), /編集権限/);
    await assert.rejects(ui.api.adjustMaterialStock({}), /編集権限/);
  }
});
