import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const snapshot = (seconds, jobs = []) => ({ jobs, intake: [], settings: { syncIntervalSeconds: seconds }, mode: "demo", access: { role: "owner", canEdit: true, isOwner: true } });

function harness(seconds) {
  let now = 0, nextId = 0, installed = 0, calls = 0, result = () => snapshot(seconds);
  const intervals = new Map(), timeouts = new Map();
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
  vm.runInContext(`${source.replace(/\ninit\(\);\s*$/, "")}\nglobalThis.ui = { state, api, init, refreshData, startAutoSync, handleAccessRequired, backgroundOperations, pendingProcessSaves, setPinch(value) { ledgerPinch = value; }, saveRevision() { mutationRevision++; processSaveRevision++; } };`, c);
  for (const name of ["applyTheme", "renderSkeletons", "bindEvents", "bindLedgerDisplay", "switchView", "setStartupState", "setConnection", "renderAll", "showToast", "reconcilePolishingRetry", "renderBackgroundActivity"]) c[name] = () => {};
  c.ui.api.getSnapshot = () => { calls++; return Promise.resolve().then(result); };
  return { ...c.ui, document, intervals, c, calls: () => calls, installed: () => installed,
    respond: fn => { result = fn; },
    activeDelay: () => { assert.equal(intervals.size, 1); return [...intervals.values()][0].ms; },
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
