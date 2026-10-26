import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [appSource, controllerSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/materials-ui.js", import.meta.url), "utf8"),
]);

const tick = () => new Promise(setImmediate);
function inventory(code = "INITIAL", quantity = 1) {
  return { materials: [{ id: "material-1", code, name: "慈大式彫骨器", stockQuantity: quantity, onOrderQuantity: 0 }], orders: [], history: [], unresolved: [] };
}

function element() {
  return {
    innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, open: false, dataset: {}, style: {}, listeners: new Map(),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); },
    async fire(type, extra = {}) { for (const callback of this.listeners.get(type) || []) await callback({ target: this, preventDefault() {}, ...extra }); },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
  };
}

function harness(initial = inventory()) {
  const elements = new Map();
  const get = (selector) => {
    const key = selector.replaceAll("'", '"');
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  };
  const panel = get('[data-view-panel="materials"]');
  const form = get("#material-form");
  const fields = ["materialId", "date", "quantity", "expectedDate", "note"].map((name) => ({ ...element(), name }));
  fields.forEach((field) => { fields[field.name] = field; });
  fields.namedItem = (name) => fields[name];
  form.elements = fields;
  form.reset = () => fields.forEach((field) => { field.value = ""; });
  elements.set("#material-form-material", fields.materialId);
  const calls = {};
  let success, failure;
  const run = { withSuccessHandler(callback) { success = callback; return this; }, withFailureHandler(callback) { failure = callback; return this; } };
  for (const method of ["getSnapshot", "getMaterialInventory", "saveJob", "approveIntake", "saveMaterialOrder", "receiveMaterialOrder", "adjustMaterialStock", "cancelMaterialOrder"]) {
    calls[method] = [];
    run[method] = (payload) => { calls[method].push({ payload, resolve: success, reject: failure }); };
  }
  let id = 0;
  const messages = [];
  const context = vm.createContext({
    document: { readyState: "complete", querySelector: get, querySelectorAll: () => [], body: element() },
    window: { google: { script: { run } } },
    localStorage: { getItem() { return null; }, setItem() {} },
    crypto: { randomUUID: () => `sync-request-${++id}` },
    setTimeout, clearTimeout, structuredClone,
  });
  vm.runInContext(controllerSource, context);
  vm.runInContext(`${appSource.slice(0, appSource.indexOf("async function init()"))}\nglobalThis.ui = { state, api, getMaterialUi, renderMaterialWorkspace, refreshMaterialInventory, invalidateMaterialInventory, refreshData, get refreshPending() { return materialRefreshPromise; } };`, context);
  const { ui } = context;
  ui.state.mode = "live";
  ui.state.activeView = "materials";
  ui.state.access = { role: "editor", canEdit: true, canWork: true };
  ui.state.materialInventory = initial;
  context.renderAll = () => ui.renderMaterialWorkspace();
  context.setConnection = () => {};
  context.setStartupState = () => {};
  context.reconcilePolishingRetry = () => {};
  context.showToast = (message) => messages.push(message);
  ui.renderMaterialWorkspace();
  return {
    ui, context, calls, get, fields, form, messages,
    fullSnapshot(materialInventory, extra = {}) { return { materialInventory, access: { role: "editor", canEdit: true, canWork: true }, jobs: [], intake: [], settings: {}, serverTime: "2026-10-20T00:00:00Z", mode: "live", ...extra }; },
    async openAdjustment() {
      const button = { ...element(), dataset: { materialAction: "adjust", materialId: "material-1" } };
      await panel.fire("click", { target: { closest: () => button } });
      fields.quantity.value = "2";
      fields.note.value = "現物の返却";
    },
  };
}

test("parent renders during an initial inventory read do not invalidate the same null snapshot", async () => {
  const h = harness(null);
  assert.equal(h.calls.getMaterialInventory.length, 1);
  h.ui.renderMaterialWorkspace();
  h.ui.renderMaterialWorkspace();
  assert.equal(h.calls.getMaterialInventory.length, 1);
  const fresh = inventory("FRESH", 9);
  h.calls.getMaterialInventory[0].resolve(fresh);
  await h.ui.refreshPending;
  assert.equal(h.ui.state.materialInventory, fresh);
  assert.match(h.get("#material-stock-rows").innerHTML, /FRESH/);
});

test("the parent's unchanged snapshot reference does not cancel a dedicated read", async () => {
  const h = harness();
  const read = h.ui.refreshMaterialInventory();
  h.ui.renderMaterialWorkspace();
  h.ui.renderMaterialWorkspace();
  h.calls.getMaterialInventory[0].resolve(inventory("REFRESHED", 8));
  await read;
  assert.equal(h.ui.state.materialInventory.materials[0].code, "REFRESHED");
  assert.equal(h.calls.getMaterialInventory.length, 1);
});

test("a successful background job save can invalidate then render before its material reread completes", async () => {
  const h = harness();
  const saved = h.ui.api.saveJob({ id: "job-1" });
  h.calls.saveJob[0].resolve({ id: "job-1", quantity: 4 });
  await saved;
  h.ui.renderMaterialWorkspace();
  assert.equal(h.calls.getMaterialInventory.length, 1);
  h.calls.getMaterialInventory[0].resolve(inventory("AFTER-JOB", -3));
  await h.ui.refreshPending;
  assert.equal(h.ui.state.materialInventory.materials[0].code, "AFTER-JOB");
  assert.match(h.get("#material-stock-rows").innerHTML, /不足 3 セット/);
});

test("invalidations during a read coalesce into a follow-up read and discard the stale response", async () => {
  const h = harness();
  const reading = h.ui.refreshMaterialInventory();
  h.ui.invalidateMaterialInventory();
  h.ui.invalidateMaterialInventory();
  h.ui.renderMaterialWorkspace();
  h.calls.getMaterialInventory[0].resolve(inventory("STALE", 50));
  await tick();
  assert.equal(h.calls.getMaterialInventory.length, 2);
  assert.equal(h.ui.state.materialInventory, null);
  assert.doesNotMatch(h.get("#material-stock-rows").innerHTML, /STALE/);
  h.calls.getMaterialInventory[1].resolve(inventory("LATEST", -2));
  await reading;
  assert.equal(h.ui.state.materialInventory.materials[0].code, "LATEST");
  assert.equal(h.calls.getMaterialInventory.length, 2);
});

test("job invalidation while a material mutation is pending queues a read and suppresses its older mutation snapshot", async () => {
  const h = harness();
  await h.openAdjustment();
  const adjustment = h.form.fire("submit");
  const job = h.ui.api.saveJob({ id: "job-1" });
  h.calls.saveJob[0].resolve({ id: "job-1", quantity: 4 });
  await job;
  h.ui.renderMaterialWorkspace();
  assert.equal(h.calls.getMaterialInventory.length, 0);
  h.calls.adjustMaterialStock[0].resolve(inventory("BEFORE-JOB", 3));
  await adjustment;
  assert.equal(h.ui.state.materialInventory, null);
  assert.equal(h.calls.getMaterialInventory.length, 1);
  assert.doesNotMatch(h.get("#material-stock-rows").innerHTML, /BEFORE-JOB/);
  h.calls.getMaterialInventory[0].resolve(inventory("AFTER-BOTH", -1));
  await tick();
  assert.equal(h.ui.state.materialInventory.materials[0].code, "AFTER-BOTH");
});

test("queued reread and parent sync preserve a failed draft and its unchanged request ID", async () => {
  const h = harness();
  await h.openAdjustment();
  const adjustment = h.form.fire("submit");
  const requestId = h.calls.adjustMaterialStock[0].payload.requestId;
  h.ui.invalidateMaterialInventory();
  h.ui.renderMaterialWorkspace();
  h.calls.adjustMaterialStock[0].reject(new Error("Network error"));
  await adjustment;
  assert.equal(h.get("#material-dialog").open, true);
  assert.equal(h.fields.note.value, "現物の返却");
  assert.equal(h.fields.quantity.value, "2");
  h.calls.getMaterialInventory[0].resolve(inventory("READ-AFTER-FAILURE", 2));
  await tick();
  h.ui.renderMaterialWorkspace();
  assert.match(h.get("#material-form-status").textContent, /反映済みの可能性/);
  const retry = h.form.fire("submit");
  assert.equal(h.calls.adjustMaterialStock[1].payload.requestId, requestId);
  h.calls.adjustMaterialStock[1].resolve(inventory("RETRY-CONFIRMED", 2));
  await retry;
  assert.equal(h.get("#material-dialog").open, false);
});

test("an older full sync cannot overwrite a dedicated material read", async () => {
  const h = harness();
  const fullSync = h.ui.refreshData({ quiet: true });
  const dedicated = h.ui.refreshMaterialInventory();
  h.calls.getMaterialInventory[0].resolve(inventory("DEDICATED-NEWER", 7));
  await dedicated;
  h.calls.getSnapshot[0].resolve(h.fullSnapshot(inventory("FULL-STALE", 1)));
  await fullSync;
  assert.equal(h.ui.state.materialInventory.materials[0].code, "DEDICATED-NEWER");
  assert.match(h.get("#material-stock-rows").innerHTML, /DEDICATED-NEWER/);
  assert.equal(h.messages.length, 0);
});

test("an older full sync cannot refill inventory invalidated by a background order update", async () => {
  const h = harness();
  const fullSync = h.ui.refreshData({ quiet: true });
  h.ui.invalidateMaterialInventory();
  h.calls.getSnapshot[0].resolve(h.fullSnapshot(inventory("FULL-BEFORE-JOB", 20)));
  await fullSync;
  assert.equal(h.ui.state.materialInventory, null);
  h.calls.getMaterialInventory[0].resolve(inventory("JOB-CURRENT", 16));
  await tick();
  assert.equal(h.ui.state.materialInventory.materials[0].code, "JOB-CURRENT");
});
