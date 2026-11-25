import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const snapshot = (seconds, jobs = []) => ({ jobs, intake: [], settings: { syncIntervalSeconds: seconds }, mode: "demo", access: { role: "owner", canEdit: true, isOwner: true } });
const scopedSnapshot = (jobs, access = snapshot(20).access) => ({ jobs, settings: { syncIntervalSeconds: 20 }, mode: "demo", access });
const settle = () => new Promise(setImmediate);

function harness(seconds) {
  let now = 0, nextId = 0, installed = 0, calls = 0, result = () => snapshot(seconds);
  const intervals = new Map(), timeouts = new Map(), requests = [];
  const storage = new Map();
  const element = { hidden: false, textContent: "", focus() {}, classList: { add() {}, remove() {}, toggle() {} } };
  const document = { visibilityState: "visible", querySelector: () => element, querySelectorAll: () => [], body: element };
  const c = vm.createContext({ Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone,
    window: { addEventListener() {} }, document, navigator: {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (fn, ms) => { const id = ++nextId; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = ++nextId; installed++; intervals.set(id, { fn, ms, due: now + ms }); return id; },
    clearInterval: id => intervals.delete(id),
  });
  vm.runInContext(`${source.replace(/\ninit\(\);\s*$/, "")}\nglobalThis.ui = { state, api, init, refreshData, startAutoSync, handleAccessRequired, loadDeferredData, deferredReads, refreshIntakeAfterImport, backgroundOperations, pendingProcessSaves, setPinch(value) { ledgerPinch = value; }, saveRevision() { mutationRevision++; processSaveRevision++; } };`, c);
  for (const name of ["applyTheme", "renderSkeletons", "bindEvents", "bindLedgerDisplay", "switchView", "setStartupState", "setConnection", "renderAll", "renderActiveView", "renderIntakeBadge", "renderAiImportStatus", "showToast", "reconcilePolishingRetry", "renderBackgroundActivity"]) c[name] = () => {};
  c.ui.api.getSnapshot = (request) => { calls++; requests.push(request); return Promise.resolve().then(() => result(request)); };
  return { ...c.ui, document, intervals, c, requests, calls: () => calls, installed: () => installed,
    respond: fn => { result = fn; },
    activeDelay: () => { assert.equal(intervals.size, 1); return [...intervals.values()][0].ms; },
    runPrefetch() {
      const next = [...timeouts.entries()].find(([, timer]) => timer.ms === 0);
      assert.ok(next, "a prefetch task is scheduled");
      timeouts.delete(next[0]);
      next[1].fn();
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...intervals.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.due;
        await timer.fn();
        if (intervals.has(id)) timer.due += timer.ms;
      }
      now = end;
    },
  };
}

for (const [value, expected] of [[10, 10000], ["20", 20000], [300, 300000], [undefined, 20000], [null, 20000], ["", 20000], ["bad", 20000], [9, 20000], [301, 20000], [10.5, 20000], [true, 20000], [[10], 20000], ["0x10", 20000]]) {
  test(`N06 initial saved interval ${JSON.stringify(value)} schedules ${expected}ms`, async () => {
    const h = harness(value);
    await h.init();
    assert.equal(h.activeDelay(), expected);
    assert.equal(h.calls(), 1);
    await h.advance(expected - 1);
    assert.equal(h.calls(), 1);
    await h.advance(1);
    assert.equal(h.calls(), 2, "quiet sync fires at the saved interval");
    assert.equal(h.installed(), 1, "an unchanged snapshot never replaces or duplicates the timer");
  });
}

test("N06 first snapshot configures one timer only after it arrives", async () => {
  const h = harness(); let resolve;
  h.respond(() => new Promise(done => { resolve = done; }));
  const loading = h.init(); await Promise.resolve();
  assert.equal(h.intervals.size, 0);
  resolve(snapshot(300)); await loading;
  assert.equal(h.activeDelay(), 300000);
  assert.equal(h.installed(), 1);
});

test("N06 failed first fetch recovers on the default timer and adopts another device's settings", async () => {
  const h = harness();
  h.respond(() => { throw new Error("synthetic first fetch failure"); });
  await h.init();
  assert.equal(h.activeDelay(), 20000);
  h.respond(() => snapshot(300));
  await h.advance(20000);
  assert.equal(h.activeDelay(), 300000);
  assert.equal(h.calls(), 2);
  h.respond(() => snapshot(10));
  await h.advance(300000);
  assert.equal(h.activeDelay(), 10000);
  await h.advance(10000);
  assert.equal(h.calls(), 4);
  assert.equal(h.installed(), 3);
});

test("N06 quiet timer preserves hidden/save/pinch suppression and skips overlapping snapshots", async () => {
  const h = harness(10); await h.init();
  h.document.visibilityState = "hidden"; await h.advance(10000);
  h.document.visibilityState = "visible";
  h.backgroundOperations.set("save", {}); await h.advance(10000); h.backgroundOperations.clear();
  h.setPinch({}); await h.advance(10000); h.setPinch(null);
  assert.equal(h.calls(), 1);
  let resolve;
  h.respond(() => new Promise(done => { resolve = done; }));
  const callback = [...h.intervals.values()][0].fn;
  const pending = callback(); await Promise.resolve(); await callback();
  assert.equal(h.calls(), 2, "only one request may be in flight");
  resolve(snapshot(10)); await pending;
  assert.equal(h.activeDelay(), 10000);
  assert.equal(h.installed(), 1);
});

test("N06 a delayed pre-save response cannot replace new jobs, settings or their timer", async () => {
  const h = harness(10); await h.init(); let resolve;
  h.respond(() => new Promise(done => { resolve = done; }));
  const pending = h.advance(10000); await Promise.resolve();
  h.pendingProcessSaves.set("new", {}); h.saveRevision();
  h.state.jobs = [{ id: "new", version: 7 }]; h.state.settings = { syncIntervalSeconds: 300 };
  resolve(snapshot(10, [{ id: "old", version: 1 }])); await pending;
  assert.equal(h.state.jobs[0].id, "new");
  assert.equal(h.state.settings.syncIntervalSeconds, 300);
  assert.equal(h.activeDelay(), 300000);
  h.pendingProcessSaves.clear();
});

test("refreshing jobs after a stock save skips stock reads while periodic sync still refreshes stock", async () => {
  const h = harness(10); await h.init();
  h.state.activeView = "finishedStock";
  const stockRefreshes = [];
  h.c.invalidateFinishedStock = (options) => stockRefreshes.push(options);
  h.respond(() => snapshot(10, [{ id: "reopened-job", version: 5 }]));
  await h.refreshData({ quiet: true, refreshFinishedStock: false });
  assert.equal(h.state.jobs[0].id, "reopened-job");
  assert.equal(stockRefreshes.length, 0);
  await h.advance(10000);
  assert.equal(stockRefreshes.length, 1);
  assert.equal(stockRefreshes[0].passive, true);
});

test("N06 revocation stops polling and reauthentication restarts only one current timer", async () => {
  const h = harness(300); await h.init();
  h.handleAccessRequired(); assert.equal(h.intervals.size, 0);
  await h.advance(900000); assert.equal(h.calls(), 1);
  h.state.accessRevoked = false; h.respond(() => snapshot(10));
  await h.init(); h.startAutoSync(); h.startAutoSync();
  assert.equal(h.activeDelay(), 10000);
  assert.equal(h.installed(), 2);
  await h.advance(10000); assert.equal(h.calls(), 3);
});

test("first paint precedes ordered prefetch and a selected tab starts while another section is loading", async () => {
  const h = harness(20);
  const trace = [];
  let finishJobs, finishIntake;
  h.respond(({ scope }) => {
    trace.push(scope);
    if (scope === "orders") return scopedSnapshot([{ id: "working" }]);
    return new Promise(resolve => { finishJobs = resolve; });
  });
  h.c.renderAll = () => trace.push("render");
  h.c.refreshMaterialInventory = async () => { trace.push("materials"); };
  h.c.renderFinishedStockWorkspace = async () => { trace.push("finishedStock"); };
  h.api.getIntakeSnapshot = () => {
    trace.push("intake");
    return new Promise(resolve => { finishIntake = resolve; });
  };
  h.api.getAccessSettings = async () => { trace.push("accessSettings"); return { users: [] }; };

  await h.init();
  assert.deepEqual(trace, ["orders", "render"]);
  assert.equal(h.requests[0].includeMaterials, false);
  assert.equal(h.state.jobHistoryReady, false);

  h.runPrefetch(); await settle();
  assert.equal(trace.at(-1), "jobs");
  h.state.activeView = "intake";
  const intake = h.loadDeferredData("intake");
  assert.equal(h.loadDeferredData("intake"), intake);
  assert.equal(trace.at(-1), "intake", "the foreground request does not wait for history");
  finishIntake({ intake: [{ id: "pending", status: "pending" }] });
  await intake;
  assert.equal(h.state.intake[0].id, "pending");
  assert.equal(h.state.jobHistoryReady, false);

  finishJobs(scopedSnapshot([{ id: "working" }, { id: "shipped", shippingStatus: "shipped" }]));
  await settle();
  assert.equal(h.state.jobHistoryReady, true);
  assert.equal(h.state.jobs[1].id, "shipped");
  for (const section of ["materials", "finishedStock", "accessSettings"]) {
    h.runPrefetch(); await settle();
    assert.equal(trace.at(-1), section);
  }
  await h.loadDeferredData("intake");
  assert.equal(trace.filter(section => section === "intake").length, 1, "opening a warm tab reuses its data");
});

test("history prefetch failure keeps the ledger and allows another section and a history retry", async () => {
  const h = harness(20);
  h.respond(({ scope }) => {
    if (scope === "orders") return scopedSnapshot([{ id: "working" }]);
    throw new Error("history offline");
  });
  await h.init();
  h.runPrefetch(); await settle();
  assert.equal(h.deferredReads.get("jobs").error, true);
  assert.equal(h.state.jobs[0].id, "working");
  assert.equal(h.state.jobHistoryReady, false);

  let materialReads = 0;
  h.c.refreshMaterialInventory = async () => { materialReads++; };
  h.runPrefetch(); await settle();
  assert.equal(materialReads, 1);

  h.respond(() => scopedSnapshot([{ id: "working" }, { id: "shipped" }]));
  assert.equal(await h.loadDeferredData("jobs"), true);
  assert.equal(h.deferredReads.get("jobs").error, false);
  assert.equal(h.state.jobs[1].id, "shipped");
});

test("a pending queue read predating an import cannot overwrite the fresh queue", async () => {
  const h = harness(20);
  h.respond(() => scopedSnapshot([]));
  await h.init();
  const responses = [];
  h.api.getIntakeSnapshot = () => new Promise(resolve => { responses.push(resolve); });
  const pending = h.loadDeferredData("intake");
  const imported = h.refreshIntakeAfterImport();
  responses[0]({ intake: [{ id: "old", status: "pending" }] });
  assert.equal(await pending, false);
  assert.equal(h.state.intake.length, 0);
  await settle();
  assert.equal(responses.length, 2);
  responses[1]({ intake: [{ id: "new", status: "pending" }] });
  await imported;
  assert.equal(h.state.intake[0].id, "new");
});

test("permission downgrades discard an intake response already in flight", async () => {
  const h = harness(20);
  h.respond(() => scopedSnapshot([]));
  await h.init();
  let finishIntake;
  h.api.getIntakeSnapshot = () => new Promise(resolve => { finishIntake = resolve; });
  const intake = h.loadDeferredData("intake");
  h.respond(() => scopedSnapshot([], { role: "worker", canWork: true, canEdit: false }));
  await h.refreshData();
  finishIntake({ intake: [{ id: "private", status: "pending" }], aiImport: { ready: true } });
  assert.equal(await intake, false);
  assert.equal(h.deferredReads.has("intake"), false);
  assert.equal(h.state.intake.length, 0);
  assert.equal(h.state.aiImport.ready, false);
});
