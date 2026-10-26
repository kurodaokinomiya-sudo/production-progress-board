import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const stageKeys = ["welding", "base", "grinding", "heat", "finish"];

function harness() {
  class Element {
    constructor(id = "") {
      this.id = id; this.dataset = {}; this.open = false; this.hidden = false;
      this.textContent = ""; this.style = {}; this.opens = 0; this.attributes = {};
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
        toggle: (name, force) => force === undefined ? (classes.has(name) ? classes.delete(name) : classes.add(name)) : (force ? classes.add(name) : classes.delete(name)),
      };
    }
    set value(value) { this._value = String(value ?? ""); }
    get value() { return this._value || ""; }
    showModal() { this.open = true; this.opens += 1; }
    close() { this.open = false; }
    focus() {}
    scrollIntoView() {}
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  class FormData {
    constructor(form) { this.entries = Object.entries(form.elements).map(([name, field]) => [name, field.value]); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element(selector.replace(/^#/, "")));
    return elements.get(selector);
  };
  const processDialog = element("#process-dialog");
  const orderDialog = element("#order-dialog");
  const discardDialog = element("#discard-dialog");
  const dialogs = [orderDialog, processDialog, discardDialog];
  const orderForm = element("#order-form");
  orderForm.elements = Object.fromEntries([
    "id", "version", "customer", "product", "productCode", "dueDate", "quantity", "serialNo", "category", "priority",
    "labelPrintStatus", "specLength", "specShape", "bladeWidth", "note", "labelKeywords",
  ].map((name) => [name, new Element(name)]));
  const orderErrors = Object.fromEntries(["customer", "product"].map((name) => [name, new Element(`error-${name}`)]));
  orderForm.querySelector = (selector) => {
    const errorName = selector.match(/^\[data-error-for='([^']+)'\]$/)?.[1];
    if (errorName) return orderErrors[errorName] || null;
    if (selector === "[aria-invalid='true']") return Object.values(orderForm.elements).find((field) => field.attributes["aria-invalid"] === "true") || null;
    return null;
  };
  orderForm.reset = () => Object.values(orderForm.elements).forEach((field) => { field.value = ""; });
  const form = element("#process-form");
  form.elements = { id: new Element("id"), version: new Element("version") };
  form.reset = () => Object.values(form.elements).forEach((field) => { field.value = ""; });
  const rows = stageKeys.map((key) => {
    const row = new Element(key);
    row.dataset.stageKey = key;
    row.selected = new Element(); row.selected.dataset.status = "not_started";
    row.assignee = new Element();
    row.querySelector = (selector) => selector === ".stage-control.is-selected" ? row.selected : selector === ".stage-assignee-input" ? row.assignee : null;
    return row;
  });
  form.querySelectorAll = (selector) => selector === ".stage-edit-row" ? rows : [];
  form.querySelector = (selector) => {
    const key = selector.match(/data-stage-key='([^']+)'/)?.[1];
    return rows.find((row) => row.dataset.stageKey === key) || null;
  };
  const document = {
    body: new Element("body"), activeElement: null,
    querySelector: (selector) => selector === "dialog[open]" ? dialogs.find((dialog) => dialog.open) || null : element(selector),
    querySelectorAll: (selector) => selector === "dialog[open]" ? dialogs.filter((dialog) => dialog.open) : [],
  };
  const calls = { toast: [], saves: [], deferred: [], submits: [], validationBlocked: [], submitPromises: [] };
  let successHandler, failureHandler;
  const run = {
    withSuccessHandler(callback) { successHandler = callback; return this; },
    withFailureHandler(callback) { failureHandler = callback; return this; },
    saveJob(input) { calls.saves.push(input); calls.deferred.push({ resolve: successHandler, reject: failureHandler }); },
    saveJobProcess(input) { calls.saves.push(input); calls.deferred.push({ resolve: successHandler, reject: failureHandler }); },
    setJobArchived(input) { calls.saves.push(input); calls.deferred.push({ resolve: successHandler, reject: failureHandler }); },
    getSnapshot(input) { calls.snapshots ||= []; calls.snapshots.push({ input, resolve: successHandler, reject: failureHandler }); },
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, structuredClone,
    HTMLElement: Element, FormData, document, window: { crypto: webcrypto, google: { script: { run } } },
    localStorage: { getItem() { return null; }, setItem() {} }, setTimeout, clearTimeout,
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, api, refreshData, backgroundOperations, pendingJobMutations, failedOrderDrafts, deleteOrder, restoreDeletedOrder, openOrderDialog, openProcessDialog, closeDialog, confirmDiscardEdits, dialogHasUnsavedEdits, processEditSnapshot, savePendingDialogEdits, saveOrder, saveProcess, failedProcessDrafts, handleAccessRequired };`, context);
  const ui = context.ui;
  const job = {
    id: "JOB-1", version: 2, customer: "得意先", product: "ケリソンパンチ 18cm 上向 3mm", quantity: 2,
    serialNo: "QA-100", dueDate: "2026-11-10", note: "注文時の備考", shippingStatus: "not_ready",
    stages: Object.fromEntries(stageKeys.map((key, index) => [key, { status: index ? "not_started" : "working", assignee: index ? "" : "豊" }])),
  };
  ui.state.access = { role: "editor", canEdit: true, canWork: true };
  ui.state.jobs = [structuredClone(job)];
  context.renderStageEditor = (input) => {
    rows.forEach((row) => {
      const status = input.stages[row.dataset.stageKey]?.status;
      row.selected.dataset.status = ["not_started", "working", "done", "hold"].includes(status) ? status : "not_started";
      row.assignee.value = input.stages[row.dataset.stageKey]?.assignee || "";
    });
  };
  context.renderProcessLifecycleAction = () => {};
  context.renderAll = () => {};
  context.announce = () => {};
  context.switchView = () => {};
  context.showToast = (message, options) => calls.toast.push({ message, options });
  const submit = (form, handler) => {
    form.requestSubmit = () => {
      calls.submits.push(form.id);
      if (form.nativeInvalid) {
        calls.validationBlocked.push(form.id);
        return;
      }
      const promise = handler({ currentTarget: form, preventDefault() {} });
      calls.submitPromises.push(promise);
    };
  };
  submit(orderForm, ui.saveOrder);
  submit(form, ui.saveProcess);
  return { ui, job, rows, form, orderForm, processDialog, orderDialog, discardDialog, calls, orderErrors, element };
}

test("工程・注文は開いた直後の自動補完を未保存の変更と扱わず閉じる", () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  assert.equal(h.ui.dialogHasUnsavedEdits(h.processDialog), false);
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.processDialog.open, false);
  h.ui.openOrderDialog(h.job);
  assert.equal(h.orderForm.elements.specLength.value, "18cm");
  assert.equal(h.ui.dialogHasUnsavedEdits(h.orderDialog), false);
  h.ui.closeDialog(h.orderDialog);
  assert.equal(h.orderDialog.open, false);
  h.ui.openOrderDialog();
  h.ui.closeDialog(h.orderDialog);
  assert.equal(h.orderDialog.open, false);
  assert.equal(h.discardDialog.opens, 0);
});

test("工程の担当空白と不明な状態は表示時の正規化として扱い、未編集警告を出さない", () => {
  const h = harness();
  h.job.stages.welding.assignee = " 豊 ";
  h.job.stages.base.status = "unknown-status";
  h.ui.state.jobs[0] = structuredClone(h.job);
  h.ui.openProcessDialog(h.job);
  assert.equal(h.rows[0].assignee.value, " 豊 ");
  assert.equal(h.rows[1].selected.dataset.status, "not_started");
  assert.equal(h.ui.dialogHasUnsavedEdits(h.processDialog), false);
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.processDialog.open, false);
  assert.equal(h.discardDialog.opens, 0);
});

test("工程の保存スナップショットは無効状態・空の出荷状態・担当空白を正規化する", () => {
  const h = harness();
  const snapshot = JSON.parse(h.ui.processEditSnapshot({
    stages: {
      welding: { status: "working", assignee: " 豊 " },
      base: { status: "unknown-status", assignee: "" },
    },
  }));
  assert.deepEqual(snapshot, {
    stages: {
      welding: { status: "working", assignee: "豊" },
      base: { status: "not_started", assignee: "" },
      grinding: { status: "not_started", assignee: "" },
      heat: { status: "not_started", assignee: "" },
      finish: { status: "not_started", assignee: "" },
    },
    shippingStatus: "not_ready",
  });
});

test("工程の担当変更は閉じる前に確認し、編集継続では入力を保持、破棄後は保存値へ戻る", () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].assignee.value = "鈴";
  h.ui.closeDialog(h.processDialog);
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.processDialog.open, true);
  assert.equal(h.discardDialog.open, true);
  assert.equal(h.discardDialog.opens, 1, "閉じる連打で確認ダイアログを重ねない");
  h.ui.closeDialog(h.discardDialog, { force: true });
  assert.equal(h.processDialog.open, true);
  assert.equal(h.rows[0].assignee.value, "鈴");
  h.ui.closeDialog(h.processDialog);
  h.ui.confirmDiscardEdits();
  assert.equal(h.discardDialog.open, false);
  assert.equal(h.processDialog.open, false);
  h.ui.openProcessDialog(h.job);
  assert.equal(h.rows[0].assignee.value, "豊");
  assert.equal(h.ui.dialogHasUnsavedEdits(h.processDialog), false);
});

test("工程の状態・出荷変更も確認し、変更を元へ戻すと無警告で閉じる", () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].selected.dataset.status = "hold";
  h.form.dataset.shippingStatus = "waiting";
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.discardDialog.open, true);
  h.ui.closeDialog(h.discardDialog, { force: true });
  h.rows[0].selected.dataset.status = "working";
  h.form.dataset.shippingStatus = "not_ready";
  h.form.elements.version.value = "99";
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.processDialog.open, false);
  assert.equal(h.discardDialog.opens, 1);
});

test("注文の実入力変更を保護し、編集継続と破棄の選択を反映する", () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.quantity.value = "8";
  h.orderForm.elements.note.value = "未保存の備考";
  h.ui.closeDialog(h.orderDialog);
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.discardDialog.open, true);
  h.ui.closeDialog(h.discardDialog, { force: true });
  assert.equal(h.orderForm.elements.quantity.value, "8");
  assert.equal(h.orderForm.elements.note.value, "未保存の備考");
  h.ui.closeDialog(h.orderDialog);
  h.ui.confirmDiscardEdits();
  assert.equal(h.orderDialog.open, false);
  h.ui.openOrderDialog(h.job);
  assert.equal(h.orderForm.elements.quantity.value, "2");
  assert.equal(h.orderForm.elements.note.value, "注文時の備考");
});

test("注文の入力を元に戻し版番号だけが変わった場合は確認しない", () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.product.value = "一時変更";
  h.orderForm.elements.product.value = h.job.product;
  h.orderForm.elements.version.value = "99";
  h.ui.closeDialog(h.orderDialog);
  assert.equal(h.orderDialog.open, false);
  assert.equal(h.discardDialog.opens, 0);
});

test("未保存工程の保存は即時クローズし、保存中の再編集を止め、遅い応答は別案件の入力を保つ", async () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].selected.dataset.status = "hold";
  const event = { currentTarget: h.form, preventDefault() {} };
  const saving = h.ui.saveProcess(event);
  assert.equal(h.processDialog.open, false);
  assert.equal(h.discardDialog.opens, 0);
  h.ui.openProcessDialog(h.job);
  assert.equal(h.processDialog.open, false);
  await h.ui.saveProcess(event);
  assert.equal(h.calls.saves.length, 1);
  const nextJob = { ...structuredClone(h.job), id: "JOB-2" };
  h.ui.state.jobs.push(nextJob);
  h.ui.openProcessDialog(nextJob);
  h.rows[0].assignee.value = "鈴";
  h.calls.deferred[0].resolve({ ...h.calls.saves[0], version: 3 });
  await saving;
  assert.equal(h.processDialog.open, true);
  assert.equal(h.form.elements.id.value, nextJob.id);
  assert.equal(h.rows[0].assignee.value, "鈴");
  assert.equal(h.ui.dialogHasUnsavedEdits(h.processDialog), true);
});

test("保存失敗の復元入力も未保存として保護し、明示した破棄は復元用入力を削除する", async () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].selected.dataset.status = "hold";
  h.rows[0].assignee.value = "鈴";
  const saving = h.ui.saveProcess({ currentTarget: h.form, preventDefault() {} });
  h.calls.deferred[0].reject(new Error("network unavailable"));
  await saving;
  assert.equal(h.ui.state.jobs[0].stages.welding.status, "working");
  h.calls.toast.at(-1).options.action.run();
  assert.equal(h.processDialog.open, true);
  assert.equal(h.rows[0].selected.dataset.status, "hold");
  assert.equal(h.rows[0].assignee.value, "鈴");
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.discardDialog.open, true);
  h.ui.confirmDiscardEdits();
  assert.equal(h.ui.failedProcessDrafts.has(h.job.id), false);
  h.ui.openProcessDialog(h.ui.state.jobs[0]);
  assert.equal(h.rows[0].selected.dataset.status, "working");
  assert.equal(h.rows[0].assignee.value, "豊");
});

test("警告からの工程保存は正しいフォームを送信し、失敗時に復元入力を残す", async () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].selected.dataset.status = "hold";
  h.rows[0].assignee.value = "鈴";
  h.ui.closeDialog(h.processDialog);
  assert.equal(h.discardDialog.open, true);

  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, ["process-form"]);
  assert.equal(h.discardDialog.open, false);
  assert.equal(h.processDialog.open, false);
  assert.equal(h.calls.saves.length, 1);
  assert.equal(h.calls.saves[0].stages.welding.status, "hold");
  assert.equal(h.calls.saves[0].stages.welding.assignee, "鈴");

  h.calls.deferred[0].reject(new Error("network unavailable"));
  await h.calls.submitPromises[0];
  assert.equal(h.ui.failedProcessDrafts.has(h.job.id), true);
  h.calls.toast.at(-1).options.action.run();
  assert.equal(h.processDialog.open, true);
  assert.equal(h.rows[0].selected.dataset.status, "hold");
  assert.equal(h.rows[0].assignee.value, "鈴");
  assert.equal(h.ui.dialogHasUnsavedEdits(h.processDialog), true);
});

test("保存して閉じるは作業員の工程を1回だけ保存し、編集権限のない注文は警告を保つ", async () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].assignee.value = "鈴";
  h.ui.closeDialog(h.processDialog);
  h.ui.state.access = { role: "worker", canWork: true };
  h.ui.savePendingDialogEdits();
  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, ["process-form"], "連打しても1回だけ送信する");
  assert.equal(h.discardDialog.open, false);
  assert.equal(h.processDialog.open, false);
  h.calls.deferred[0].resolve({ ...h.calls.saves[0], version: 3 });
  await h.calls.submitPromises[0];
  assert.equal(h.ui.state.jobs[0].stages.welding.assignee, "鈴");
  assert.equal(h.ui.state.jobs[0].version, 3);

  h.ui.state.access = { role: "editor", canEdit: true, canWork: true };
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "未保存の注文";
  h.ui.closeDialog(h.orderDialog);
  h.ui.state.access = { role: "worker", canWork: true };
  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, ["process-form"], "作業員は注文フォームを送信できない");
  assert.equal(h.discardDialog.open, true);
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.orderForm.elements.note.value, "未保存の注文");
});

test("注文を保存して閉じるはrequestSubmit経由で直ちに閉じて保存を続ける", async () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "保存する備考";
  h.ui.closeDialog(h.orderDialog);

  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, ["order-form"]);
  assert.equal(h.discardDialog.open, false);
  assert.equal(h.orderDialog.open, false);
  assert.equal(h.ui.state.orderSaving, true);
  assert.equal(h.orderForm.elements.note.value, "保存する備考");
  h.calls.deferred[0].resolve({ ...h.calls.saves[0], version: 3 });
  await h.calls.submitPromises[0];
  assert.equal(h.orderDialog.open, false);
  assert.equal(h.ui.state.orderSaving, false);
  assert.equal(h.ui.state.jobs[0].note, "保存する備考");
});

test("requestSubmitのネイティブ制約違反はフォームと入力を保つ", () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "未保存の備考";
  h.ui.closeDialog(h.orderDialog);
  h.orderForm.nativeInvalid = true;

  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, ["order-form"]);
  assert.deepEqual(h.calls.validationBlocked, ["order-form"]);
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.discardDialog.open, false);
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.orderForm.elements.note.value, "未保存の備考");
});

test("注文内容の業務検証エラーはフォームと入力を保つ", () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.customer.value = "";
  h.ui.closeDialog(h.orderDialog);

  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, ["order-form"]);
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.discardDialog.open, false);
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.orderForm.elements.customer.value, "");
  assert.equal(h.orderForm.elements.customer.attributes["aria-invalid"], "true");
  assert.match(h.orderErrors.customer.textContent, /得意先が未入力/);
});

test("注文保存失敗後は入力を保持し、復元操作で編集画面を開く", async () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "保存できなかった備考";
  h.ui.closeDialog(h.orderDialog);
  h.ui.savePendingDialogEdits();

  h.calls.deferred[0].reject(new Error("network unavailable"));
  await h.calls.submitPromises[0];
  assert.equal(h.orderDialog.open, false);
  assert.equal(h.ui.state.orderSaving, false);
  h.calls.toast.at(-1).options.action.run();
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.orderForm.elements.note.value, "保存できなかった備考");
  assert.match(h.calls.toast.at(-1).message, /案件を保存できませんでした/);
});

test("注文保存中は保存して閉じるを重ねず、確認を残す", () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "未保存の注文";
  h.ui.closeDialog(h.orderDialog);
  h.ui.pendingJobMutations.set(h.job.id, "注文を保存中…");

  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, []);
  assert.equal(h.discardDialog.open, true);
  assert.equal(h.orderDialog.open, true);
});

test("保存時に権限が失われた場合はフォームを送信せず警告を残す", () => {
  const h = harness();
  h.ui.openProcessDialog(h.job);
  h.rows[0].assignee.value = "鈴";
  h.ui.closeDialog(h.processDialog);
  h.ui.state.access = { role: "viewer", canWork: false };
  h.ui.savePendingDialogEdits();
  assert.deepEqual(h.calls.submits, []);
  assert.equal(h.discardDialog.open, true);
  assert.equal(h.processDialog.open, true);
});

test("保存中の注文を閉じず、権限失効による強制終了は未保存確認より優先する", () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "未保存";
  h.ui.pendingJobMutations.set(h.job.id, "注文を保存中…");
  h.ui.closeDialog(h.orderDialog);
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.discardDialog.opens, 0);
  h.ui.closeDialog(h.orderDialog, { force: true });
  assert.equal(h.orderDialog.open, false);
  h.ui.pendingJobMutations.clear();
  h.ui.openProcessDialog(h.job);
  h.rows[0].assignee.value = "鈴";
  h.ui.handleAccessRequired();
  assert.equal(h.processDialog.open, false);
  assert.equal(h.discardDialog.opens, 0);
  assert.equal(h.ui.state.accessRevoked, true);
  assert.equal(h.ui.state.jobs.length, 0);
});

test("注文を連続保存でき、応答の順序が逆でも別案件の編集中フォームを閉じない", async () => {
  const h = harness();
  const second = { ...structuredClone(h.job), id: "JOB-2" };
  h.ui.state.jobs.push(second);
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.note.value = "最初の保存";
  const firstSave = h.ui.saveOrder({ currentTarget: h.orderForm, preventDefault() {} });
  assert.equal(h.orderDialog.open, false);
  h.ui.openOrderDialog(h.job);
  assert.equal(h.orderDialog.open, false, "same pending job stays locked");
  h.ui.openOrderDialog(second);
  h.orderForm.elements.note.value = "二番目の保存";
  const secondSave = h.ui.saveOrder({ currentTarget: h.orderForm, preventDefault() {} });
  assert.equal(h.calls.saves.length, 2);
  assert.equal(h.ui.backgroundOperations.size, 2);
  h.ui.openOrderDialog();
  h.orderForm.elements.product.value = "次の新規入力";
  h.calls.deferred[1].resolve({ ...h.calls.saves[1], version: 3 });
  await secondSave;
  assert.equal(h.ui.state.orderSaving, true);
  h.calls.deferred[0].resolve({ ...h.calls.saves[0], version: 3 });
  await firstSave;
  assert.equal(h.ui.state.orderSaving, false);
  assert.equal(h.ui.backgroundOperations.size, 0);
  assert.equal(h.orderDialog.open, true);
  assert.equal(h.orderForm.elements.product.value, "次の新規入力");
  assert.deepEqual(h.ui.state.jobs.map(job => job.note), ["最初の保存", "二番目の保存"]);
});

test("別案件の入力中に保存が失敗しても割り込まず、保存前の材料入力まで復元する", async () => {
  const h = harness();
  const second = { ...structuredClone(h.job), id: "JOB-2" };
  h.ui.state.jobs.push(second);
  h.ui.openOrderDialog(h.job);
  h.orderForm.elements.product.value = "ケリソンパンチ 白銅";
  h.orderForm.elements.labelKeywords.value = "白銅";
  h.orderForm.elements.note.value = "失敗しても残す";
  const saving = h.ui.saveOrder({ currentTarget: h.orderForm, preventDefault() {} });
  h.ui.openOrderDialog(second);
  h.orderForm.elements.note.value = "別案件を入力中";
  h.calls.deferred[0].reject(new Error("offline"));
  await saving;
  assert.equal(h.orderForm.elements.id.value, second.id);
  assert.equal(h.orderForm.elements.note.value, "別案件を入力中");
  const recover = h.calls.toast.at(-1).options.action.run;
  recover();
  assert.equal(h.orderForm.elements.id.value, second.id);
  h.ui.closeDialog(h.orderDialog, { force: true });
  recover();
  assert.equal(h.orderForm.elements.product.value, "ケリソンパンチ 白銅");
  assert.equal(h.orderForm.elements.labelKeywords.value, "白銅");
  assert.equal(h.orderForm.elements.note.value, "失敗しても残す");
  assert.equal(h.ui.dialogHasUnsavedEdits(h.orderDialog), true);
});

test("新規注文の失敗は仮表示を除き、再試行も同じIDとsourceRefを使う", async () => {
  const h = harness();
  h.ui.openOrderDialog();
  h.orderForm.elements.customer.value = "得意先";
  h.orderForm.elements.product.value = "新規製品";
  const saving = h.ui.saveOrder({ currentTarget: h.orderForm, preventDefault() {} });
  const first = h.calls.saves[0];
  assert.ok(first.id);
  assert.equal(h.ui.state.jobs[0].product, "新規製品");
  h.calls.deferred[0].reject(new Error("response lost"));
  await saving;
  assert.equal(h.ui.state.jobs.length, 1);
  h.calls.toast.at(-1).options.action.run();
  const retry = h.ui.saveOrder({ currentTarget: h.orderForm, preventDefault() {} });
  assert.equal(h.calls.saves[1].id, first.id);
  assert.equal(h.calls.saves[1].sourceRef, first.sourceRef);
  h.calls.deferred[1].resolve({ ...h.calls.saves[1], version: 1 });
  await retry;
  assert.equal(h.ui.state.jobs.length, 2);
});

test("削除中の同期は重複実行せず、削除前の遅いスナップショットを適用しない", async () => {
  const h = harness();
  h.ui.state.mode = "live";
  const refreshing = h.ui.refreshData({ quiet: true });
  await h.ui.refreshData({ quiet: true });
  assert.equal(h.calls.snapshots.length, 1);
  h.ui.openOrderDialog(h.job);
  const deleting = h.ui.deleteOrder();
  assert.equal(h.orderDialog.open, false);
  assert.equal(h.ui.state.jobs[0].archived, true);
  await h.ui.refreshData({ quiet: true });
  assert.equal(h.calls.snapshots.length, 1);
  h.calls.deferred[0].resolve({ ...h.job, archived: true, version: 3 });
  await deleting;
  h.calls.snapshots[0].resolve({ jobs: [h.job], settings: {}, intake: [], access: h.ui.state.access, mode: "live" });
  await refreshing;
  assert.equal(h.ui.state.jobs[0].archived, true);
  assert.equal(h.ui.state.jobs[0].version, 3);
});

test("削除失敗は一覧へ戻し、復元も即時表示と失敗時のロールバックを行う", async () => {
  const h = harness();
  h.ui.openOrderDialog(h.job);
  const deleting = h.ui.deleteOrder();
  h.calls.deferred[0].reject(new Error("stale version"));
  await deleting;
  assert.equal(Boolean(h.ui.state.jobs[0].archived), false);
  assert.match(h.calls.toast.at(-1).message, /一覧に戻しました/);
  const archived = { ...h.job, archived: true, version: 3 };
  h.ui.state.jobs = [archived];
  const restoring = h.ui.restoreDeletedOrder(archived);
  assert.equal(h.ui.state.jobs[0].archived, false);
  h.calls.deferred[1].reject(new Error("offline"));
  await restoring;
  assert.equal(h.ui.state.jobs[0].archived, true);
});

test("初回ロード失敗は再試行を出し、成功後に読み込み画面を外す", async () => {
  const h = harness();
  const loading = h.ui.refreshData();
  assert.equal(h.element("#startup-loading").hidden, false);
  h.calls.snapshots[0].reject(new Error("offline"));
  await loading;
  assert.equal(h.element("#startup-retry").hidden, false);
  assert.match(h.element("#startup-title").textContent, /できませんでした/);
  const retry = h.ui.refreshData();
  h.calls.snapshots[1].resolve({ jobs: [h.job], intake: [], settings: {}, access: h.ui.state.access, mode: "live" });
  await retry;
  assert.equal(h.element("#startup-loading").hidden, true);
});

test("保存中の権限失効後に遅い成功・失敗が届いても案件や復元入力を再表示しない", async () => {
  for (const success of [true, false]) {
    const h = harness();
    h.ui.openOrderDialog(h.job);
    const saving = h.ui.saveOrder({ currentTarget: h.orderForm, preventDefault() {} });
    h.ui.handleAccessRequired();
    if (success) h.calls.deferred[0].resolve({ ...h.job, version: 3 });
    else h.calls.deferred[0].reject(new Error("permission changed"));
    await saving;
    assert.equal(h.ui.state.jobs.length, 0);
    assert.equal(h.ui.failedOrderDrafts.size, 0);
    assert.equal(h.element("#background-activity").hidden, true);
  }
});
