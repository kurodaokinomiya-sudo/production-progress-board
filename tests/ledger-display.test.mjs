import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const storageKey = "production-board-ledger-display-v1";

function harness(initialStorage = null) {
  const storage = new Map();
  if (initialStorage !== null) storage.set(storageKey, initialStorage);
  const elements = new Map();
  const calls = { prevented: 0 };
  const frames = new Map();
  let nextFrame = 0;
  function eventTarget() {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, handler, options) { listeners.set(type, { handler, options }); },
      removeEventListener(type, handler) { if (listeners.get(type)?.handler === handler) listeners.delete(type); },
    };
  }
  const view = eventTarget();
  const jobs = [{ id: "job-1", product: "試験案件", stages: { welding: { status: "working" } } }];

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        ...eventTarget(),
        style: { setProperty(name, value) { this[name] = value; } },
        textContent: "",
        value: "100",
        disabled: false,
        dataset: {},
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
      });
    }
    return elements.get(selector);
  }

  const document = {
    body: { classList: { toggle() {} } },
    querySelector(selector) {
      if (selector === ".ledger-view.is-active .ledger-viewport") return viewport;
      if (selector === ".status-footer") return { getBoundingClientRect: () => ({ height: 28 }) };
      return element(selector);
    },
    querySelectorAll(selector) {
      if (selector === ".ledger-viewport") return [viewport];
      if (selector === ".ledger-view") return [view];
      if (selector === "[data-ledger-scale]") return [scaleOutput];
      if (selector === "[data-ledger-zoom]") return zoomButtons;
      return [];
    },
  };
  const viewport = {
    ...eventTarget(),
    scrollLeft: 40,
    scrollTop: 20,
    clientWidth: 1000,
    classes: new Set(),
    classList: { toggle(name, active) { if (active) viewport.classes.add(name); else viewport.classes.delete(name); } },
    querySelector: (selector) => selector === ".ledger-content" ? content : null,
    querySelectorAll(selector) {
      const factor = Number(viewport.style["--ledger-scale"] || 1);
      if (selector === "tbody > tr[data-order-id]") return Array.from({ length: 33 }, (_, index) => ({ getBoundingClientRect: () => ({ height: 26 * factor, top: 20 + (50 + index * 26) * factor, bottom: 20 + (50 + (index + 1) * 26) * factor }) }));
      if (selector === "thead") return [{ getBoundingClientRect: () => ({ height: 26 * factor }) }];
      return [];
    },
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    contains: (target) => target?.withinViewport === true,
    style: { setProperty(name, value) { this[name] = value; } },
  };
  const content = {
    naturalWidth: 1500, scrollRoom: 0,
    getBoundingClientRect: () => ({ top: 20, width: (content.naturalWidth + content.scrollRoom) * Number(viewport.style["--ledger-scale"] || 1) }),
    querySelector: (selector) => selector === ".ledger-scroll-space" ? { getBoundingClientRect: () => ({ width: content.scrollRoom * Number(viewport.style["--ledger-scale"] || 1) }) } : null,
  };
  const scaleOutput = element("scale-output");
  const zoomButtons = ["out", "in", "fit", "progress"].map((action) => ({
    dataset: { ledgerZoom: action, ledgerRows: "33" },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const viewportTarget = {
    closest(selector) {
      if (selector === ".ledger-viewport") return viewport;
      if (selector === ".ledger-zoom") return null;
      return null;
    },
  };
  const zoomTarget = {
    closest(selector) {
      if (selector === ".ledger-viewport") return null;
      if (selector === ".ledger-zoom") return element("zoom-controls");
      return null;
    },
  };

  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document,
    window: { innerHeight: 900, addEventListener() {} },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  });
  const exported = [
    "clampLedgerScale", "fitLedgerScale", "readStoredLedgerDisplay", "applyLedgerScale",
    "ledgerAnchor", "handleLedgerWheel", "handleLedgerTouchStart", "handleLedgerTouchMove",
    "handleLedgerTouchEnd", "updateLedgerOverflow", "bindLedgerDisplay", "renderLedgerTable", "state",
    "flushLedgerScale", "commitLedgerScaleInput", "selectLedgerPreset", "selectLedgerProgressView", "orderTableHeader", "orderTableRows", "renderActiveView", "renderAll",
  ].join(", ");
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { ${exported} };`, context);
  return {
    ui: context.ui,
    storage,
    viewport,
    content,
    zoomButtons,
    view,
    viewportTarget,
    zoomTarget,
    calls,
    jobs,
    frames,
    context,
    scaleInput: scaleOutput,
    preventable(target, extra = {}) {
      return {
        target,
        cancelable: true,
        deltaY: 40,
        deltaMode: 0,
        clientX: 110,
        clientY: 120,
        ctrlKey: false,
        metaKey: false,
        preventDefault() { calls.prevented += 1; },
        ...extra,
      };
    },
  };
}

test("ledger scale clamps to supported bounds and invalid saved preferences use fit defaults", () => {
  const { ui } = harness();
  assert.equal(ui.clampLedgerScale(10), 40);
  assert.equal(ui.clampLedgerScale(170), 160);
  assert.equal(ui.clampLedgerScale(83.6), 84);
  assert.equal(ui.clampLedgerScale(Number.NaN), 100);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.readStoredLedgerDisplay())), { mode: "fit", scale: 100, rows: 33, compact: false, progressOnly: false });

  for (const invalid of ["{", JSON.stringify({ mode: "auto", scale: 90 }), JSON.stringify({ mode: "manual", scale: "80" }), JSON.stringify({ mode: "fit", scale: null })]) {
    const saved = harness(invalid).ui.readStoredLedgerDisplay();
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), { mode: "fit", scale: 100, rows: 33, compact: false, progressOnly: false });
  }
  const clamped = harness(JSON.stringify({ mode: "manual", scale: 999 })).ui.readStoredLedgerDisplay();
  assert.deepEqual(JSON.parse(JSON.stringify(clamped)), { mode: "manual", scale: 160, rows: 33, compact: false, progressOnly: false });
});

test("fit scale keeps at least 33 rows visible when the requested layout fits within bounds", () => {
  const { ui } = harness();
  const availableHeight = 900;
  const rowHeight = 26;
  const headerHeight = 26;
  const scale = ui.fitLedgerScale(availableHeight, rowHeight, headerHeight);
  const visibleRows = Math.floor((availableHeight - 20 - headerHeight) / (rowHeight * scale / 100));
  assert.ok(visibleRows >= 33, `expected 33 visible rows at ${scale}%, got ${visibleRows}`);
  assert.equal(ui.fitLedgerScale(40, rowHeight, headerHeight), 40);
  assert.equal(ui.fitLedgerScale(5000, rowHeight, headerHeight), 160);
});

test("saved display preferences retain 23-product focus mode and migrate the previous format", () => {
  const saved = harness(JSON.stringify({ mode: "fit", scale: 110, rows: 23, compact: true })).ui.readStoredLedgerDisplay();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { mode: "fit", scale: 110, rows: 23, compact: true, progressOnly: false });
  const legacy = harness(JSON.stringify({ mode: "manual", scale: 80 })).ui.readStoredLedgerDisplay();
  assert.deepEqual(JSON.parse(JSON.stringify(legacy)), { mode: "manual", scale: 80, rows: 33, compact: false, progressOnly: false });
  const progress = harness(JSON.stringify({ mode: "fit", scale: 150, rows: 23, compact: true, progressOnly: true })).ui.readStoredLedgerDisplay();
  assert.deepEqual(JSON.parse(JSON.stringify(progress)), { mode: "manual", scale: 150, rows: 23, compact: false, progressOnly: true });
  const untrustedFlag = harness(JSON.stringify({ mode: "manual", scale: 150, compact: false, progressOnly: "true" })).ui.readStoredLedgerDisplay();
  assert.equal(untrustedFlag.progressOnly, false, "only a boolean true enables the specialized view");
  assert.equal(untrustedFlag.compact, false);
});

test("23-product preset enlarges the table and focus mode can be returned to normal", () => {
  const { ui, context, storage } = harness();
  let rendered = 0;
  context.renderActiveView = () => { rendered += 1; };
  ui.selectLedgerPreset(33);
  assert.equal(ui.state.ledgerDisplay.compact, false);
  const small = ui.state.ledgerDisplay.scale;
  ui.selectLedgerPreset(23);
  assert.ok(ui.state.ledgerDisplay.scale > small);
  assert.equal(ui.state.ledgerDisplay.compact, true);
  assert.equal(ui.state.ledgerDisplay.rows, 23);
  assert.equal(ui.state.ledgerDisplay.mode, "fit");
  ui.selectLedgerPreset(33);
  assert.equal(ui.state.ledgerDisplay.compact, false);
  assert.equal(rendered, 3);
  assert.equal(JSON.parse(storage.get(storageKey)).rows, 33);
  assert.equal(JSON.parse(storage.get(storageKey)).compact, false);
});

test("progress-only button sets 160% manual view, persists it, and either preset exits it", () => {
  const { ui, context, storage, zoomTarget, zoomButtons } = harness();
  let renders = 0, layouts = 0;
  context.renderActiveView = () => { renders += 1; };
  context.layoutLedger = () => { layouts += 1; };
  ui.selectLedgerProgressView();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.state.ledgerDisplay)), { mode: "manual", scale: 160, rows: 33, compact: false, progressOnly: true });
  assert.deepEqual(JSON.parse(storage.get(storageKey)), JSON.parse(JSON.stringify(ui.state.ledgerDisplay)));
  assert.equal(renders, 1);
  assert.equal(layouts, 1);
  assert.equal(zoomButtons.find((button) => button.dataset.ledgerZoom === "progress").attributes["aria-pressed"], "true");
  assert.match(html, /data-ledger-zoom="progress"[^>]*>拡大（160%）<\/button>/);
  assert.equal((html.match(/data-ledger-zoom="progress"/g) || []).length, 2);

  ui.selectLedgerPreset(23);
  assert.equal(ui.state.ledgerDisplay.progressOnly, false);
  assert.equal(ui.state.ledgerDisplay.compact, true);
  assert.equal(JSON.parse(storage.get(storageKey)).progressOnly, false);
  ui.selectLedgerProgressView();
  ui.selectLedgerPreset(33);
  assert.equal(ui.state.ledgerDisplay.progressOnly, false);
  assert.equal(ui.state.ledgerDisplay.compact, false);
});

test("ledger tables put product and serial first and progress view contains only those plus five live stage cells", () => {
  const { ui } = harness();
  const keys = (markup) => Array.from(markup.matchAll(/<th scope="col" class="cell-([^"]+)"/g), (match) => match[1]);
  const full = keys(ui.orderTableHeader({ ledger: true, category: "鋭匙鉗子" }));
  const compact = keys(ui.orderTableHeader({ ledger: true, compact: true, category: "鋭匙鉗子" }));
  assert.deepEqual(full.slice(0, 8), ["product", "serial", "customer", "due", "quantity", "length", "shape", "blade"]);
  assert.deepEqual(compact.slice(0, 8), ["product", "serial", "customer", "due", "quantity", "length", "shape", "blade"]);
  assert.equal(full.length, 17);
  assert.equal(compact.length, 14);
  assert.deepEqual(keys(ui.orderTableHeader()).slice(0, 2), ["customer", "product"], "non-ledger tables keep their existing column order");

  const progressHeader = ui.orderTableHeader({ ledger: true, progressOnly: true, category: "鋭匙鉗子" });
  const progressKeys = keys(progressHeader);
  assert.deepEqual(progressKeys, ["product", "serial", "stage", "stage", "stage", "stage", "stage"]);
  assert.match(progressHeader, /頭付け・幅取り/);
  assert.doesNotMatch(progressHeader, /得意先|納期|数量|全長|研磨|備考|出荷/);

  const rowJob = { id: "job", product: "試験品", serialNo: "001", category: "鋭匙鉗子", quantity: 5, shippingStatus: "not_ready", stages: { heat: { status: "working", assignee: "鈴" } } };
  const row = ui.orderTableRows([rowJob], { ledger: true, progressOnly: true })
    .match(/<tr[^>]*>([\s\S]*?)<\/tr>/)[1];
  assert.equal((row.match(/<td class="cell-/g) || []).length, 7);
  assert.match(row, /class="ledger-scroll-space" aria-hidden="true"/);
  assert.ok(row.indexOf("cell-product") < row.indexOf("cell-serial"));
  assert.ok(row.indexOf("cell-serial") < row.indexOf("cell-stage"));
  assert.match(row, /鈴/);
  assert.match(ui.orderTableHeader({ ledger: true, progressOnly: true, category: "ケリソンパンチ" }), /厚みとり/);

  ui.state.access = { role: "worker", canWork: true };
  assert.match(ui.orderTableRows([rowJob], { ledger: true, progressOnly: true }), /data-action="open-process"/);
  ui.state.access = { role: "viewer" };
  assert.doesNotMatch(ui.orderTableRows([rowJob], { ledger: true, progressOnly: true }), /data-action="open-process"/);
});

test("progress-only layout changes invalidate cached markup and reset horizontal scroll", () => {
  const { ui, jobs, context } = harness();
  context.layoutLedger = () => {};
  context.scheduleLedgerLayout = () => {};
  let markup = "", surface = { dataset: { ledgerLayout: "full" }, scrollTop: 140, scrollLeft: 240 }, writes = 0;
  const workspace = {
    isConnected: true,
    querySelector: (selector) => selector === ".ledger-viewport" ? surface : null,
    get innerHTML() { return markup; },
    set innerHTML(value) {
      writes += 1;
      markup = value;
      const layout = value.match(/data-ledger-layout="([^"]+)"/)?.[1] || "full";
      surface = { dataset: { ledgerLayout: layout }, scrollTop: 0, scrollLeft: 0 };
    },
  };
  ui.state.ledgerDisplay.progressOnly = false;
  ui.renderLedgerTable(workspace, jobs);
  assert.equal(writes, 1);
  ui.renderLedgerTable(workspace, jobs);
  assert.equal(writes, 1, "same layout and data retain cached markup");
  surface.scrollLeft = 240;
  surface.scrollTop = 140;
  ui.state.ledgerDisplay.progressOnly = true;
  ui.renderLedgerTable(workspace, jobs);
  assert.equal(writes, 2, "progressOnly participates in the render signature");
  assert.match(markup, /data-ledger-layout="progress"/);
  assert.equal(surface.scrollLeft, 0, "switching layout returns to the first visible columns");
  assert.equal(surface.scrollTop, 140, "vertical position is retained");
  ui.state.ledgerDisplay.progressOnly = false;
  surface.scrollLeft = 220;
  ui.renderLedgerTable(workspace, jobs);
  assert.equal(writes, 3);
  assert.equal(surface.scrollLeft, 0);
});

test("typed scale commits on Enter, clamps invalid ranges and preserves the focus preference", () => {
  const { ui, scaleInput, storage } = harness();
  ui.state.ledgerDisplay.rows = 23;
  ui.state.ledgerDisplay.compact = true;
  scaleInput.blur = () => {};
  ui.bindLedgerDisplay();
  scaleInput.value = "85";
  scaleInput.listeners.get("keydown").handler({ key: "Enter", preventDefault() {} });
  assert.equal(ui.state.ledgerDisplay.scale, 85);
  assert.equal(ui.state.ledgerDisplay.mode, "manual");
  assert.equal(JSON.parse(storage.get(storageKey)).compact, true);
  scaleInput.value = "500";
  ui.commitLedgerScaleInput(scaleInput);
  assert.equal(scaleInput.value, "160");
  scaleInput.value = "";
  ui.commitLedgerScaleInput(scaleInput);
  assert.equal(scaleInput.value, "160");
  scaleInput.value = "not a number";
  ui.commitLedgerScaleInput(scaleInput);
  assert.equal(ui.state.ledgerDisplay.scale, 160);
});

test("fit counts only the headings before its target products, excluding later tables", () => {
  const { ui, context, viewport } = harness();
  context.renderActiveView = () => {};
  const query = viewport.querySelectorAll;
  viewport.querySelectorAll = (selector) => selector === "thead" || selector === ".ledger-category-heading"
    ? Array.from({ length: 3 }, () => ({ getBoundingClientRect: () => ({ height: 100 }) })) : query(selector);
  ui.selectLedgerPreset(23);
  const height = Number.parseInt(viewport.style.height);
  assert.equal(ui.state.ledgerDisplay.scale, ui.fitLedgerScale(height, 26, 50, 23));
  const factor = ui.state.ledgerDisplay.scale / 100;
  assert.equal(Math.floor((height / factor - 50) / 26), 23);
});

test("focus table keeps the product and every process while omitting notes and right-hand controls", () => {
  const { ui, jobs } = harness();
  const header = ui.orderTableHeader({ compact: true });
  const row = ui.orderTableRows(jobs, { compact: true });
  assert.equal((header.match(/<th scope=/g) || []).length, 14);
  assert.equal((row.match(/<td[ >]/g) || []).length, 14);
  assert.doesNotMatch(header, /大分類|分類/);
  assert.match(header, /仕上げ[\s\S]*研磨/);
  assert.doesNotMatch(header, /備考|出荷完了|>編集</);
  assert.doesNotMatch(row, /cell-note|cell-shipping|edit-order/);
  const standardHeader = ui.orderTableHeader();
  const standardRow = ui.orderTableRows(jobs);
  assert.equal((standardHeader.match(/<th scope=/g) || []).length, 17);
  assert.equal((standardRow.match(/<td[ >]/g) || []).length, 17);
  assert.doesNotMatch(standardHeader, /大分類|分類/);
  assert.match(standardRow, /cell-note/);
});

test("background refresh renders only the active view and switching sees current job data", () => {
  const { ui, context } = harness();
  const rendered = [];
  for (const name of ["renderMetrics", "renderDashboardOrders", "renderOrdersWorkspace", "renderCompletedWorkspace", "renderDistributionWorkspace", "renderPolishingWorkspace", "renderIntake", "renderSettings"]) {
    context[name] = () => rendered.push([name, ui.state.jobs[0]?.version]);
  }
  context.renderHeader = () => {};
  context.applyAccessVisibility = () => {};
  ui.state.mode = "live";
  ui.state.jobs = [{ id: "job-1", version: 1 }];
  ui.state.activeView = "orders";
  ui.renderAll();
  ui.state.jobs[0].version = 2;
  ui.renderAll();
  assert.deepEqual(rendered, [["renderOrdersWorkspace", 1], ["renderOrdersWorkspace", 2]]);
  ui.state.activeView = "completed";
  ui.renderActiveView();
  assert.deepEqual(rendered.at(-1), ["renderCompletedWorkspace", 2]);
  ui.state.activeView = "dashboard";
  ui.renderActiveView();
  assert.deepEqual(rendered.slice(-2), [["renderMetrics", 2], ["renderDashboardOrders", 2]]);
});

test("rapid zoom events share one animation frame, accumulate wheel steps and measure overflow once", () => {
  const { ui, viewportTarget, content, frames } = harness();
  let measurements = 0;
  const originalMeasure = content.getBoundingClientRect;
  content.getBoundingClientRect = () => { measurements += 1; return originalMeasure(); };
  for (let index = 0; index < 2; index += 1) ui.handleLedgerWheel({ ...eventWith(viewportTarget), deltaY: -100, ctrlKey: true });
  assert.equal(ui.state.ledgerDisplay.scale, 100);
  assert.equal(frames.size, 1);
  assert.equal(measurements, 0);
  [...frames.values()][0]();
  assert.equal(ui.state.ledgerDisplay.scale, 135);
  assert.equal(measurements, 1);
  assert.equal(frames.size, 0);
});

test("plain wheel scrolls while Ctrl-wheel and zoom-control wheel scale and persist", () => {
  const { ui, storage, viewportTarget, zoomTarget, calls, viewport } = harness();
  const start = ui.state.ledgerDisplay.scale;
  ui.handleLedgerWheel({ ...eventWith(viewportTarget), cancelable: true, deltaY: 40, ctrlKey: false });
  assert.equal(ui.state.ledgerDisplay.scale, start);
  assert.equal(calls.prevented, 0);
  assert.equal(storage.has(storageKey), false);

  ui.handleLedgerWheel({ ...eventWith(viewportTarget), cancelable: true, deltaY: -100, ctrlKey: true, clientX: 110, clientY: 120 });
  ui.flushLedgerScale();
  assert.ok(ui.state.ledgerDisplay.scale > start);
  assert.equal(JSON.parse(storage.get(storageKey)).mode, "manual");
  const afterCtrl = ui.state.ledgerDisplay.scale;
  ui.handleLedgerWheel({ ...eventWith(zoomTarget), cancelable: true, deltaY: 100 });
  ui.flushLedgerScale();
  assert.ok(ui.state.ledgerDisplay.scale < afterCtrl);
  assert.equal(JSON.parse(storage.get(storageKey)).scale, ui.state.ledgerDisplay.scale);
  assert.equal(viewport.style["--ledger-scale"], String(ui.state.ledgerDisplay.scale / 100));
});

test("one-finger touch preserves scrolling; pinch scales around its anchor and saves only on end", () => {
  const { ui, storage, viewport, viewportTarget, calls, jobs } = harness();
  const originalJobs = JSON.stringify(jobs);
  const oneTouch = { clientX: 30, clientY: 40, target: { withinViewport: true } };
  const oneFingerStart = { target: viewportTarget, touches: [oneTouch], cancelable: true, preventDefault() { calls.prevented += 1; } };
  ui.handleLedgerTouchStart(oneFingerStart);
  assert.equal(calls.prevented, 0);
  assert.equal(storage.has(storageKey), false);

  const first = { clientX: 60, clientY: 100, target: { withinViewport: true } };
  const second = { clientX: 160, clientY: 100, target: { withinViewport: true } };
  const start = { target: viewportTarget, touches: [first, second], cancelable: true, preventDefault() { calls.prevented += 1; } };
  ui.handleLedgerTouchStart(start);
  assert.equal(calls.prevented, 1);
  assert.equal(storage.has(storageKey), false);
  const move = {
    cancelable: true,
    touches: [
      { ...first, clientX: 40 },
      { ...second, clientX: 180 },
    ],
    preventDefault() { calls.prevented += 1; },
  };
  ui.handleLedgerTouchMove(move);
  ui.flushLedgerScale();
  assert.equal(ui.state.ledgerDisplay.scale, 140);
  assert.equal(storage.has(storageKey), false, "pinch movement should not write storage before touch end");
  assert.equal(viewport.scrollLeft, 96);
  assert.equal(viewport.scrollTop, 60);

  ui.handleLedgerTouchEnd({ touches: [], cancelable: true, preventDefault() { calls.prevented += 1; } });
  assert.equal(JSON.parse(storage.get(storageKey)).scale, 140);
  assert.equal(JSON.stringify(jobs), originalJobs);
});

test("pinch end applies the final queued movement before saving its scale", () => {
  const { ui, viewportTarget, view, storage, frames } = harness();
  const first = { clientX: 60, clientY: 100, target: { withinViewport: true } };
  const second = { clientX: 160, clientY: 100, target: { withinViewport: true } };
  ui.handleLedgerTouchStart({ target: viewportTarget, currentTarget: view, touches: [first, second], cancelable: true, preventDefault() {} });
  for (const [left, right] of [[55, 165], [40, 180]]) {
    ui.handleLedgerTouchMove({ touches: [{ ...first, clientX: left }, { ...second, clientX: right }], cancelable: true, preventDefault() {} });
  }
  assert.equal(ui.state.ledgerDisplay.scale, 100);
  assert.equal(frames.size, 1);
  ui.handleLedgerTouchEnd({ touches: [] });
  assert.equal(ui.state.ledgerDisplay.scale, 140);
  assert.equal(JSON.parse(storage.get(storageKey)).scale, 140);
  assert.equal(frames.size, 0);
  assert.equal(view.listeners.has("touchmove"), false);
});

test("horizontal movement is enabled only when the scaled table exceeds the viewport, in either display mode", () => {
  const { ui, viewport } = harness();
  ui.applyLedgerScale(60);
  assert.equal(viewport.classes.has("has-horizontal-overflow"), false);
  assert.equal(viewport.scrollLeft, 0);
  assert.equal(viewport.scrollTop, 20);
  ui.applyLedgerScale(100);
  assert.equal(viewport.classes.has("has-horizontal-overflow"), true);
  viewport.scrollLeft = 120;
  ui.applyLedgerScale(60, { mode: "fit" });
  assert.equal(viewport.classes.has("has-horizontal-overflow"), false);
  assert.equal(viewport.scrollLeft, 0);
  viewport.clientWidth = 800;
  ui.updateLedgerOverflow(viewport);
  assert.equal(viewport.classes.has("has-horizontal-overflow"), true, "narrowing the viewport permits required horizontal scrolling");
});

test("extra scrolling room cannot keep horizontal scrolling enabled after the data fits", () => {
  const { ui, viewport, content } = harness();
  ui.applyLedgerScale(100);
  assert.equal(viewport.style["--ledger-viewport-width"], "1000px");
  assert.equal(viewport.classes.has("has-horizontal-overflow"), true);
  content.scrollRoom = 650;
  viewport.scrollLeft = 700;
  ui.applyLedgerScale(60);
  assert.equal(viewport.classes.has("has-horizontal-overflow"), false);
  assert.equal(viewport.scrollLeft, 0);
  assert.equal(viewport.scrollTop, 20);
  assert.equal(viewport.style["--ledger-viewport-width"], `${1000 / 0.6}px`);
});

test("ordinary scrolling has no blocking touchmove listener, while pinch handling is attached only during a pinch", () => {
  const { ui, viewport, viewportTarget, view } = harness();
  ui.bindLedgerDisplay();
  assert.equal(view.listeners.has("touchmove"), false);
  assert.equal(view.listeners.get("touchend").options.passive, true);
  assert.equal(view.listeners.get("touchcancel").options.passive, true);
  const touch = { clientX: 50, clientY: 100, target: { withinViewport: true } };
  const start = { target: viewportTarget, currentTarget: view, touches: [touch], cancelable: true, preventDefault() {} };
  ui.handleLedgerTouchStart(start);
  assert.equal(view.listeners.has("touchmove"), false);
  ui.handleLedgerTouchStart({ ...start, touches: [touch, { ...touch, clientX: 150 }] });
  assert.equal(view.listeners.get("touchmove").options.passive, false);
  assert.equal(viewport.listeners.has("touchmove"), false);
  ui.handleLedgerTouchEnd({ touches: [], cancelable: true, preventDefault() { assert.fail("passive touchend must not cancel scrolling"); } });
  assert.equal(view.listeners.has("touchmove"), false);
});

test("unchanged ledger refresh retains its scroll surface; data and permission changes redraw it", () => {
  const { ui, jobs } = harness();
  let markup = "", surface = null, writes = 0;
  const workspace = {
    isConnected: false,
    querySelector: (selector) => selector === ".ledger-viewport" ? surface : null,
    get innerHTML() { return markup; },
    set innerHTML(value) { writes += 1; markup = value; surface = value.includes('class="ledger-viewport"') ? { scrollTop: 0, scrollLeft: 0 } : null; },
  };
  ui.renderLedgerTable(workspace, jobs);
  const original = surface;
  original.scrollTop = 220;
  ui.renderLedgerTable(workspace, JSON.parse(JSON.stringify(jobs)));
  assert.equal(writes, 1);
  assert.equal(surface, original);
  assert.equal(surface.scrollTop, 220);
  jobs[0].stages.welding.status = "done";
  ui.renderLedgerTable(workspace, jobs);
  assert.equal(writes, 2);
  assert.match(markup, /完了/);
  ui.state.access = { role: "worker", canWork: true };
  ui.renderLedgerTable(workspace, jobs);
  assert.equal(writes, 3);
  assert.match(markup, /data-action="open-process"/);
  ui.state.ledgerDisplay.compact = true;
  ui.renderLedgerTable(workspace, jobs);
  assert.doesNotMatch(markup, /cell-note/);
  ui.state.ledgerDisplay.compact = false;
  ui.renderLedgerTable(workspace, jobs);
  assert.match(markup, /cell-note/);
  workspace.innerHTML = "empty filter result";
  ui.renderLedgerTable(workspace, jobs);
  assert.ok(surface, "returning from an empty result must recreate the ledger even if the old signature matches");
});

function eventWith(target) {
  return {
    target,
    cancelable: true,
    deltaY: 40,
    deltaMode: 0,
    clientX: 110,
    clientY: 120,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
  };
}
