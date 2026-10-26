import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function harness(role = "viewer") {
  const storage = new Map();
  const elements = new Map();
  const classes = new Set();
  const calls = { printed: 0, saved: 0 };
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, open: true, dataset: {},
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      querySelector: (child) => element(`${selector} ${child}`), querySelectorAll: () => [], focus() {},
    });
    return elements.get(selector);
  }
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, setTimeout, clearTimeout,
    document: { querySelector: element, querySelectorAll: () => [], body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } } },
    window: { print: () => { calls.printed += 1; assert.equal(classes.has("is-printing-labels"), true); } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    requestAnimationFrame: (callback) => callback(),
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, api, canEdit, canWork, canAccessView, openOrderDialog, openLabelPrintDialog, renderLabelSelectionState, printSelectedLabels, confirmLabelsPrinted, stageCellButton, shippingCell, orderTableRows, renderDistributionWorkspace, renderAccessSettings };`, context);
  const ui = context.ui;
  ui.state.access = { email: `${role}@example.com`, role, isOwner: role === "owner", isAdmin: ["owner", "admin"].includes(role), canEdit: ["owner", "admin", "editor"].includes(role), canWork: role !== "viewer" };
  ui.state.jobs = [{ id: "one", product: "鋭匙鉗子", category: "鋭匙鉗子", dueDate: "2026-04-10", quantity: 4, version: 2, shippingStatus: "not_ready", labelPrintStatus: "waiting", distributionAssignee: "幹", stages: { welding: { assignee: "豊", status: "working" } } }];
  ui.state.labelPrintSelection = new Set(["one"]);
  ui.api.markLabelsPrinted = async () => { calls.saved += 1; return []; };
  return { ui, element, calls };
}

test("viewer label printing keeps queue state and never exposes or submits printed-state confirmation", async () => {
  const { ui, element, calls } = harness();
  ui.renderLabelSelectionState();
  assert.equal(element("#mark-selected-labels-button").hidden, true);
  assert.equal(element("#mark-selected-labels-button").disabled, true);
  assert.equal(element("#print-labels-button").disabled, false);
  ui.printSelectedLabels();
  assert.equal(calls.printed, 1);
  assert.equal(ui.state.labelPrintPendingConfirmation.length, 0);
  assert.equal(ui.state.labelPrintConfirmationVisible, false);
  assert.equal(element("#label-print-result").hidden, true);
  assert.equal(element("#label-print-result [data-action='confirm-label-printed']").disabled, true);
  await ui.confirmLabelsPrinted(null, { selected: true });
  assert.equal(calls.saved, 0);
  assert.equal(ui.state.jobs[0].labelPrintStatus, "waiting");
  ui.renderLabelSelectionState();
  assert.equal(element("#mark-selected-labels-button").hidden, true);
});

test("editor print still requires explicit confirmation before modifying the queue", () => {
  const { ui, element, calls } = harness("editor");
  ui.printSelectedLabels();
  assert.equal(calls.printed, 1);
  assert.equal(calls.saved, 0);
  assert.equal(ui.state.labelPrintPendingConfirmation.length, 1);
  assert.equal(element("#label-print-result").hidden, false);
  assert.equal(element("#label-print-result [data-action='confirm-label-printed']").disabled, false);
});

test("viewer can read stage, shipping and distribution assignment after filtering without mutation controls", () => {
  const { ui, element } = harness();
  const job = ui.state.jobs[0];
  const stage = ui.stageCellButton(job, { key: "welding", label: "溶接" });
  assert.match(stage, /豊/);
  assert.match(stage, /進行中/);
  assert.doesNotMatch(stage, /<button|data-action/);
  assert.match(ui.shippingCell(job), /未出荷/);
  assert.doesNotMatch(ui.shippingCell(job), /<button|data-action/);
  ui.state.distributionMonth = "2026-04";
  ui.renderDistributionWorkspace();
  assert.match(element("#distribution-workspace").innerHTML, /<span>幹<\/span>/);
  assert.doesNotMatch(element("#distribution-workspace").innerHTML, /data-distribution-assignee/);
  assert.equal(element("#distribution-print-button").disabled, false);
  assert.equal(ui.canEdit({}), false);
});

test("periodic account settings rendering preserves unsaved input and saving controls", () => {
  const { ui, element } = harness("owner");
  ui.state.accessSettings = { users: [{ email: "editor@example.com", role: "editor" }], adminEmail: "owner@example.com", emailVerificationReady: true };
  ui.renderAccessSettings();
  assert.match(element("#access-users").innerHTML, /editor@example.com/);
  element("#access-users").innerHTML = "unsaved input DOM";
  ui.state.accessSettingsDirty = true;
  ui.renderAccessSettings();
  assert.equal(element("#access-users").innerHTML, "unsaved input DOM");
  ui.state.accessSettingsDirty = false;
  ui.state.accessSettingsSaving = true;
  ui.renderAccessSettings();
  assert.equal(element("#access-users").innerHTML, "unsaved input DOM");
});

test("workers can update process and distribution while business editing and import navigation remain closed", () => {
  const { ui, element, calls } = harness("worker");
  const job = ui.state.jobs[0];
  assert.equal(ui.canEdit(), false);
  assert.equal(ui.canWork(), true);
  assert.equal(ui.canEdit({ role: "worker", canEdit: true }), false);
  for (const view of ["orders", "shipping", "distribution", "completed", "settings"]) assert.equal(ui.canAccessView(view), true, view);
  for (const view of ["dashboard", "intake", "unknown"]) assert.equal(ui.canAccessView(view), false, view);
  assert.match(ui.stageCellButton(job, { key: "welding", label: "溶接" }), /data-action="open-process"/);
  assert.doesNotMatch(ui.shippingCell(job), /data-action="open-process"/);
  assert.doesNotMatch(ui.orderTableRows([job]), /data-action="edit-order"/);
  ui.state.distributionMonth = "2026-04";
  ui.renderDistributionWorkspace();
  assert.match(element("#distribution-workspace").innerHTML, /data-distribution-assignee/);
  element("#order-dialog").open = false;
  element("#label-dialog").open = false;
  ui.openOrderDialog(job);
  ui.openLabelPrintDialog();
  ui.printSelectedLabels();
  assert.equal(element("#order-dialog").open, false);
  assert.equal(element("#label-dialog").open, false);
  assert.equal(calls.printed, 0);
});

test("editors retain polishing, import and every standard view, and admin role choices include the new names", () => {
  const { ui } = harness("editor");
  assert.equal(ui.canEdit(), true);
  assert.equal(ui.canWork(), true);
  for (const view of ["dashboard", "orders", "shipping", "distribution", "polishing", "completed", "settings", "intake"]) assert.equal(ui.canAccessView(view), true, view);
  const admin = harness("admin");
  admin.ui.state.accessSettings = { users: [{ email: "worker@example.com", role: "worker" }, { email: "editor@example.com", role: "editor" }], adminEmail: "owner@example.com", emailVerificationReady: true };
  admin.ui.renderAccessSettings();
  assert.match(admin.element("#access-users").innerHTML, /value="worker" selected>作業員/);
  assert.match(admin.element("#access-users").innerHTML, /value="editor" selected>編集者/);
  assert.doesNotMatch(admin.element("#access-users").innerHTML, /編集のみ/);
});
