import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const stageKeys = ["welding", "base", "grinding", "heat", "finish"];

function makeClassList() {
  const values = new Set();
  return {
    toggle(name, force) { if (force === undefined ? !values.has(name) : force) values.add(name); else values.delete(name); },
    add(name) { values.add(name); }, remove(name) { values.delete(name); }, contains(name) { return values.has(name); },
  };
}

function makeHarness() {
  const elements = new Map();
  const rows = stageKeys.map((key, index) => {
    const statuses = ["not_started", "working", "done", "hold"].map((status) => ({
      dataset: { status }, classList: makeClassList(), attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }, focus() {},
    }));
    statuses[index === 0 ? 1 : 0].classList.add("is-selected");
    const picker = { input: { value: index ? "鈴" : "豊" }, options: ["豊", "鈴", ""].map((assignee) => ({
      dataset: { assignee }, classList: makeClassList(), attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
    })) };
    picker.options.find((option) => option.dataset.assignee === picker.input.value).classList.add("is-selected");
    return { dataset: { stageKey: key }, statuses, picker, classList: makeClassList() };
  });
  const form = { dataset: { shippingStatus: "shipped", afterSaveView: "completed" }, _bulkAssignees: ["幹", "鈴"], _bulkUndo: null, elements: { id: { value: "job-1" }, version: { value: "2" } } };
  const dialog = { id: "process-dialog", open: true, close() { this.open = false; }, getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 500 }) };
  const orderDialog = { id: "order-dialog", open: false };
  const processTarget = { hidden: true, style: {}, classList: makeClassList(), setAttribute(name, value) { this[name] = value; }, querySelector() { return this.span ||= { textContent: "" }; }, getBoundingClientRect: () => ({ left: 100, top: 100, right: 180, bottom: 150 }) };
  const undo = { hidden: true };
  const lifecycle = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const processForm = form;
  form.querySelectorAll = (selector) => selector === ".stage-edit-row" ? rows : selector === ".stage-control" ? rows.flatMap((row) => row.statuses) : [];
  form.querySelector = (selector) => selector === ".stage-control.is-selected" ? rows.flatMap((row) => row.statuses).find((button) => button.classList.contains("is-selected")) : null;
  rows.forEach((row) => {
    row.querySelector = (selector) => selector === ".stage-control.is-selected" ? row.statuses.find((button) => button.classList.contains("is-selected")) : selector === ".assignee-picker" ? row.picker : null;
    row.querySelectorAll = (selector) => selector === ".stage-control" ? row.statuses : selector === ".assignee-option" ? row.picker.options : [];
    row.picker.querySelector = (selector) => selector === ".stage-assignee-input" ? row.picker.input : null;
    row.picker.querySelectorAll = (selector) => selector === ".assignee-option" ? row.picker.options : [];
  });
  const editor = { listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const job = { id: "job-1", version: 2, customer: "X", product: "P", quantity: 5, polishing: { sentQuantity: 5, returnedQuantity: 5 }, shippingStatus: "shipped", stages: Object.fromEntries(stageKeys.map((key, i) => [key, { status: i ? "done" : "working", assignee: i ? "鈴" : "豊" }])) };
  form._jobBase = job;
  const state = { jobs: [structuredClone(job)], activeView: "completed", access: { role: "editor", canEdit: true }, lastSync: null };
  const calls = { saves: [], toast: [], announce: [], render: 0, switches: [] };
  const deferred = [];
  let successHandler;
  let failureHandler;
  const run = {
    withSuccessHandler(fn) { successHandler = fn; return this; },
    withFailureHandler(fn) { failureHandler = fn; return this; },
    saveJob(order) { calls.saves.push(order); deferred.push({ resolve: successHandler, reject: failureHandler }); },
    saveJobProcess(order) { calls.saves.push(order); deferred.push({ resolve: successHandler, reject: failureHandler }); },
  };
  function element(selector) {
    if (selector === "#process-form") return processForm;
    if (selector === "#process-dialog") return dialog;
    if (selector === "#process-stage-editor") return editor;
    if (selector === "#process-all-target") return processTarget;
    if (selector === "#process-bulk-undo") return undo;
    if (selector === "#process-bulk-status") return elements.get(selector) || (elements.set(selector, { textContent: "" }), elements.get(selector));
    if (selector === "#process-lifecycle-action") return lifecycle;
    if (selector === "#process-lifecycle-note" || selector === "#process-progress") return elements.get(selector) || (elements.set(selector, { textContent: "" }), elements.get(selector));
    if (selector === "span" && processTarget) return processTarget.span ||= { textContent: "" };
    if (selector === "dialog[open]") return orderDialog.open ? orderDialog : null;
    if (selector === ".stage-control.is-selected" && processForm) return rows[0].statuses.find((button) => button.classList.contains("is-selected"));
    if (selector.startsWith(".stage-control[data-status='done']")) return rows.flatMap((row) => row.statuses).filter((button) => button.dataset.status === "done" && button.classList.contains("is-selected"));
    return elements.get(selector) || null;
  }
  function queryAll(selector) {
    if (selector === ".stage-edit-row") return rows;
    if (selector === ".stage-control") return rows.flatMap((row) => row.statuses);
    if (selector === ".assignee-option") return rows.flatMap((row) => row.picker.options);
    return [];
  }
  function query(selector, root) {
    if (root?.dataset?.stageKey) {
      if (selector === ".stage-control.is-selected") return root.statuses.find((button) => button.classList.contains("is-selected"));
      if (selector === ".assignee-picker") return root.picker;
    }
    if (root?.picker && selector === ".stage-assignee-input") return root.input;
    if (root?.picker && selector === ".assignee-option") return root.options;
    return element(selector);
  }
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, structuredClone,
    document: { querySelector: query, querySelectorAll: queryAll, activeElement: null },
    window: { crypto: { randomUUID: () => `process-request-${calls.saves.length}` }, google: { script: { run } }, addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout(fn) { const handle = { fn }; timers.push(handle); return handle; }, clearTimeout(handle) { if (handle) handle.cleared = true; },
  });
  const timers = [];
  const exported = ["applyBulkProcessChange", "startProcessGesture", "moveProcessGesture", "endProcessGesture", "cancelProcessGesture", "suppressProcessGestureClick", "state", "saveProcess", "openProcessDialog", "processSavePending"].join(", ");
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { ${exported} }; Object.defineProperty(globalThis.ui, "suppressed", { get: () => suppressedProcessClick });`, context);
  context.ui.state.jobs = state.jobs;
  context.ui.state.activeView = state.activeView;
  context.ui.state.access = state.access;
  context.renderProcessLifecycleAction = () => {};
  context.renderAll = () => { calls.render += 1; };
  context.announce = (message) => calls.announce.push(message);
  context.showToast = (message, options) => calls.toast.push({ message, options });
  context.switchView = (view) => calls.switches.push(view);
  return { ui: context.ui, context, rows, form, dialog, orderDialog, processTarget, undo, job, calls, deferred, timers, element, queryAll };
}

test("bulk status change keeps assignees, reopens shipped job, and undo restores lifecycle fields", () => {
  const h = makeHarness();
  assert.equal(h.ui.applyBulkProcessChange({ status: "hold" }), true);
  assert.deepEqual(h.rows.map((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status), Array(5).fill("hold"));
  assert.deepEqual(h.rows.map((row) => row.picker.input.value), ["豊", "鈴", "鈴", "鈴", "鈴"]);
  assert.equal(h.form.dataset.shippingStatus, "waiting");
  assert.equal(h.form.dataset.afterSaveView, "orders");
  assert.equal(h.ui.applyBulkProcessChange({ undo: true }), true);
  assert.deepEqual(h.rows.map((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status), ["working", "not_started", "not_started", "not_started", "not_started"]);
  assert.equal(h.form.dataset.shippingStatus, "shipped");
  assert.equal(h.form.dataset.afterSaveView, "completed");
});

test("bulk assignee only accepts common candidates and leaves each stage status unchanged", () => {
  const h = makeHarness();
  const before = h.rows.map((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status);
  assert.equal(h.ui.applyBulkProcessChange({ assignee: "豊" }), false);
  assert.deepEqual(h.rows.map((row) => row.picker.input.value), ["豊", "鈴", "鈴", "鈴", "鈴"]);
  assert.equal(h.ui.applyBulkProcessChange({ assignee: "幹" }), true);
  assert.deepEqual(h.rows.map((row) => row.picker.input.value), Array(5).fill("幹"));
  assert.deepEqual(h.rows.map((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status), before);
  assert.equal(h.ui.applyBulkProcessChange({ assignee: "" }), true);
  assert.deepEqual(h.rows.map((row) => row.picker.input.value), Array(5).fill(""));
  assert.deepEqual(h.rows.map((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status), before);
});

test("hold and slide applies bulk once and consumes its synthetic click; short tap does not apply", () => {
  const h = makeHarness();
  const button = h.rows[0].statuses.find((entry) => entry.dataset.status === "hold");
  button.isConnected = true;
  button.textContent = "保留";
  button.textContent = "保留";
  button.dataset.status = "hold";
  button.getBoundingClientRect = () => ({ left: 200, top: 200, width: 40, height: 30 });
  button.classList = makeClassList();
  const target = { closest: () => button };
  const event = (extra = {}) => ({ target, pointerId: 7, isPrimary: true, button: 0, clientX: 110, clientY: 120, cancelable: true, preventDefault() {}, ...extra });
  h.ui.startProcessGesture(event());
  h.timers.at(-1).fn();
  h.ui.moveProcessGesture(event());
  h.ui.endProcessGesture(event());
  assert.equal(h.rows.every((row) => row.statuses.find((entry) => entry.classList.contains("is-selected")).dataset.status === "hold"), true);
  assert.ok(h.ui.suppressed, "the armed release should establish a click suppression window");
  let prevented = 0;
  let stopped = 0;
  h.ui.suppressProcessGestureClick({ target, preventDefault() { prevented += 1; }, stopImmediatePropagation() { stopped += 1; } });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);

  const fresh = makeHarness();
  const shortButton = fresh.rows[0].statuses.find((entry) => entry.dataset.status === "hold");
  shortButton.isConnected = true;
  shortButton.getBoundingClientRect = () => ({ left: 0, top: 0, width: 40, height: 30 });
  const shortTarget = { closest: () => shortButton };
  fresh.ui.startProcessGesture({ ...event(), target: shortTarget });
  fresh.ui.endProcessGesture({ ...event(), target: shortTarget });
  assert.equal(fresh.rows.some((row) => row.statuses.find((entry) => entry.classList.contains("is-selected")).dataset.status === "hold"), false);

  const moved = makeHarness();
  const movingButton = moved.rows[0].statuses.find((entry) => entry.dataset.status === "hold");
  movingButton.isConnected = true;
  const movingTarget = { closest: () => movingButton };
  moved.ui.startProcessGesture({ ...event(), target: movingTarget });
  moved.ui.moveProcessGesture({ ...event(), target: movingTarget, clientX: 125 });
  moved.timers.at(-1).fn();
  assert.equal(moved.rows.some((row) => row.statuses.find((entry) => entry.classList.contains("is-selected")).dataset.status === "hold"), false);
  moved.ui.startProcessGesture({ ...event(), target: movingTarget });
  moved.ui.startProcessGesture({ ...event(), target: movingTarget, pointerId: 8, isPrimary: false });
  moved.timers.at(-1).fn();
  assert.equal(moved.rows.some((row) => row.statuses.find((entry) => entry.classList.contains("is-selected")).dataset.status === "hold"), false);
});

test("armed release outside target and explicit cancellation leave stages unchanged, hide target, and suppress ghost clicks", () => {
  const h = makeHarness();
  const before = h.rows.map((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status);
  const button = h.rows[0].statuses.find((entry) => entry.dataset.status === "hold");
  button.isConnected = true;
  button.textContent = "保留";
  button.getBoundingClientRect = () => ({ left: 200, top: 200, width: 40, height: 30 });
  const target = { closest: () => button };
  const event = (extra = {}) => ({ target, pointerId: 3, isPrimary: true, button: 0, clientX: 110, clientY: 120, cancelable: true, preventDefault() {}, ...extra });

  h.ui.startProcessGesture(event());
  h.timers.at(-1).fn();
  h.ui.endProcessGesture(event({ clientX: 300, clientY: 300 }));
  assert.deepEqual(h.rows.map((row) => row.statuses.find((entry) => entry.classList.contains("is-selected")).dataset.status), before);
  assert.equal(h.processTarget.hidden, true);
  assert.ok(h.ui.suppressed);
  let prevented = 0;
  h.ui.suppressProcessGestureClick({ target, preventDefault() { prevented += 1; }, stopImmediatePropagation() {} });
  assert.equal(prevented, 1);

  h.ui.startProcessGesture(event());
  h.timers.at(-1).fn();
  h.ui.cancelProcessGesture();
  assert.deepEqual(h.rows.map((row) => row.statuses.find((entry) => entry.classList.contains("is-selected")).dataset.status), before);
  assert.equal(h.processTarget.hidden, true);
  assert.ok(h.ui.suppressed);
});

test("save closes synchronously, optimistically updates, ignores duplicate submit, and leaves a later dialog alone", async () => {
  const h = makeHarness();
  h.rows[0].statuses.find((button) => button.classList.contains("is-selected")).dataset.status = "hold";
  const event = { currentTarget: h.form, preventDefault() {} };
  const saving = h.ui.saveProcess(event);
  assert.equal(h.dialog.open, false);
  assert.equal(h.calls.saves.length, 1);
  assert.equal(h.ui.state.jobs[0].stages.welding.status, "hold");
  await h.ui.saveProcess(event);
  assert.equal(h.calls.saves.length, 1);
  h.orderDialog.open = true;
  h.deferred[0].resolve({ ...h.calls.saves[0], version: 3 });
  await saving;
  assert.equal(h.orderDialog.open, true);
  assert.deepEqual(h.calls.switches, []);
  assert.equal(h.ui.processSavePending(h.job), false);
});

test("failed optimistic save rolls back the job and offers a sticky draft recovery action", async () => {
  const h = makeHarness();
  const original = structuredClone(h.ui.state.jobs[0]);
  h.rows[0].statuses.find((button) => button.classList.contains("is-selected")).dataset.status = "hold";
  const saving = h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  assert.equal(h.ui.state.jobs[0].stages.welding.status, "hold");
  h.deferred[0].reject(new Error("network unavailable"));
  await saving;
  assert.deepEqual(JSON.parse(JSON.stringify(h.ui.state.jobs[0])), JSON.parse(JSON.stringify(original)));
  assert.equal(h.calls.toast.at(-1).options.sticky, true);
  assert.equal(h.calls.toast.at(-1).options.action.label, "入力内容を開く");
});

test("late process save responses preserve newer job mutations on both success and failure", async () => {
  const success = makeHarness();
  const successPending = success.ui.saveProcess({ currentTarget: success.form, preventDefault() {} });
  const newerSuccessState = { ...success.ui.state.jobs[0], version: 9, distributionAssignee: "担当更新" };
  success.ui.state.jobs = [newerSuccessState];
  success.deferred[0].resolve({ ...success.calls.saves[0], version: 3, distributionAssignee: "古い応答" });
  await successPending;
  assert.equal(success.ui.state.jobs[0].version, 9);
  assert.equal(success.ui.state.jobs[0].distributionAssignee, "担当更新");

  const failure = makeHarness();
  const failurePending = failure.ui.saveProcess({ currentTarget: failure.form, preventDefault() {} });
  const newerFailureState = { ...failure.ui.state.jobs[0], version: 8, distributionAssignee: "担当更新" };
  failure.ui.state.jobs = [newerFailureState];
  failure.deferred[0].reject(new Error("late failure"));
  await failurePending;
  assert.equal(failure.ui.state.jobs[0].version, 8);
  assert.equal(failure.ui.state.jobs[0].distributionAssignee, "担当更新");
});

function workerFinishingHarness() {
  const h = makeHarness();
  const before = { ...h.job, shippingStatus: "not_ready", stages: { ...h.job.stages, finish: { status: "working", assignee: "豊" } } };
  h.ui.state.jobs = [before];
  h.ui.state.access = { role: "worker", canEdit: false, canWork: true };
  h.ui.state.activeView = "orders";
  h.form.dataset.shippingStatus = "not_ready";
  h.form.dataset.afterSaveView = "";
  h.form._jobBase = before;
  h.context.updateStageStatus(h.rows.at(-1), "done");
  return { ...h, before };
}

test("worker final finishing save enters shipping only after successful persistence", async () => {
  const h = workerFinishingHarness();
  const saving = h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  assert.equal(h.dialog.open, false);
  assert.equal(h.ui.state.jobs[0].stages.finish.status, "done");
  assert.deepEqual(h.calls.switches, [], "pending completion must not navigate before the server succeeds");
  h.deferred[0].resolve({ ...h.before, ...h.calls.saves[0], version: 3 });
  await saving;
  assert.deepEqual(h.calls.switches, ["shipping"]);
  assert.match(h.calls.announce.at(-1), /出荷待ちへ移動/);
});

test("failed worker completion restores the production job and retains a recoverable final-finish draft", async () => {
  const h = workerFinishingHarness();
  const saving = h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  h.deferred[0].reject(new Error("connection failed"));
  await saving;
  assert.equal(h.ui.state.jobs[0], h.before);
  assert.equal(h.ui.state.jobs[0].stages.finish.status, "working");
  assert.deepEqual(h.calls.switches, []);
  assert.equal(h.calls.toast.at(-1).options.action.label, "入力内容を開く");
});

test("worker forged shipment in a process form never reaches an API mutation", async () => {
  const h = workerFinishingHarness();
  h.form.dataset.shippingStatus = "shipped";
  await h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  assert.equal(h.calls.saves.length, 0);
  assert.match(h.calls.toast.at(-1).message, /編集権限/);
  assert.equal(h.dialog.open, true);
});

test("changing a failed completion draft back to working recomputes its destination", async () => {
  const h = workerFinishingHarness();
  const failed = h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  h.deferred[0].reject(new Error("connection failed"));
  await failed;
  h.form.dataset.afterSaveView = "shipping";
  h.context.updateStageStatus(h.rows.at(-1), "working");
  const retry = h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  h.deferred[1].resolve({ ...h.before, ...h.calls.saves[1], version: 3 });
  await retry;
  assert.equal(h.ui.state.jobs[0].stages.finish.status, "working");
  assert.deepEqual(h.calls.switches, ["orders"]);
  assert.equal(h.calls.announce.at(-1), "工程を保存しました");
});

test("bulk completion leaves ordinary finishing unchanged before a full actual polishing return", () => {
  const h = workerFinishingHarness();
  h.before.polishing = { sentQuantity: 0, returnedQuantity: 0 };
  h.context.updateStageStatus(h.rows.at(-1), "working");
  assert.equal(h.ui.applyBulkProcessChange({ status: "done" }), true);
  assert.equal(h.rows.at(-1).statuses.find((button) => button.classList.contains("is-selected")).dataset.status, "working");
  assert.ok(h.rows.slice(0, -1).every((row) => row.statuses.find((button) => button.classList.contains("is-selected")).dataset.status === "done"));
  assert.match(h.element("#process-bulk-status").textContent, /仕上げを除く/);
});
