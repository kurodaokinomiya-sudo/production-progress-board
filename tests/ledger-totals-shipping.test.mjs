import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function harness() {
  const form = { dataset: { shippingStatus: "not_ready" }, _jobBase: {}, rows: [] };
  const button = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const text = { textContent: "" };
  const note = { textContent: "" };
  const storage = new Map();
  function query(selector, root) {
    if (selector === "#process-form") return form;
    if (selector === "#process-lifecycle-action") return button;
    if (selector === "#process-lifecycle-note") return note;
    if (selector === "#process-progress" || selector === "span") return text;
    if (selector === ".stage-control.is-selected" && root?.selected) return root.selected;
    return null;
  }
  function queryAll(selector, root) {
    if (root === form && selector === ".stage-edit-row") return form.rows;
    if (root === form && selector.includes("data-status='done'")) return form.rows.filter((row) => row.selected.dataset.status === "done");
    return [];
  }
  form.querySelector = (selector) => query(selector, form);
  form.querySelectorAll = (selector) => queryAll(selector, form);
  button.querySelector = () => text;
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, structuredClone,
    document: { querySelector: query, querySelectorAll: queryAll },
    window: {}, localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { ledgerTotals, ledgerTotalsText, renderLedgerTable, isDone, currentStage, progress, processFormFinishDone, renderProcessLifecycleAction, state, api };`, context);
  context.delay = async () => {};
  context.ui.state.access = { role: "editor", canEdit: true, canWork: true };
  return { ui: context.ui, form, button, note, storage };
}

const stages = (finish = "done") => Object.fromEntries(["welding", "base", "grinding", "heat", "finish"].map((key) => [key, { status: key === "finish" ? finish : "not_started", assignee: "" }]));

test("ledger totals retain unknown quantities instead of treating them as zero", () => {
  const { ui } = harness();
  const jobs = [{ quantity: 4 }, { quantity: "6" }, { quantity: 0 }, { quantity: "" }, { quantity: null }, { quantity: "unknown" }];
  assert.deepEqual({ ...ui.ledgerTotals(jobs) }, { count: 6, quantity: 10, unknownQuantity: 3 });
  assert.equal(ui.ledgerTotalsText(jobs), "6件・10丁（数量未設定 3件）");
  assert.equal(ui.ledgerTotalsText([]), "0件・0丁");
});

test("category subtotals and final total sum only the supplied visible jobs in both ledger modes", () => {
  const { ui } = harness();
  const jobs = [
    { id: "k1", category: "ケリソンパンチ", quantity: 4, stages: stages() },
    { id: "k2", category: "ケリソンパンチ", quantity: 6, stages: stages() },
    { id: "s1", category: "鋭匙鉗子", quantity: 7, stages: stages() },
    { id: "other", category: "特注", quantity: 3, stages: stages() },
  ];
  ui.state.jobs = [...jobs, { id: "hidden", quantity: 1000 }];
  for (const compact of [false, true]) {
    ui.state.ledgerDisplay.compact = compact;
    const workspace = { innerHTML: "", isConnected: false, querySelector: () => null };
    ui.renderLedgerTable(workspace, jobs, compact);
    assert.match(workspace.innerHTML, /ケリソンパンチ 合計 <strong>2件・10丁/);
    assert.match(workspace.innerHTML, /鋭匙鉗子 合計 <strong>1件・7丁/);
    assert.match(workspace.innerHTML, /その他 合計 <strong>1件・3丁/);
    assert.match(workspace.innerHTML, /表示中の総合計 <strong>4件・20丁/);
    assert.ok(workspace.innerHTML.indexOf("ledger-grand-total") > workspace.innerHTML.indexOf("その他 合計"));
  }
});

test("final finish alone enables shipment and shipping filter, while polishing returns still block it", () => {
  const { ui, form, button, note } = harness();
  const job = { quantity: 5, stages: stages(), polishing: { sentQuantity: 5, returnedQuantity: 5 } };
  form._jobBase = job;
  form.rows = Object.entries(job.stages).map(([key, value]) => {
    const row = { dataset: { stageKey: key }, selected: { dataset: { status: value.status } } };
    row.querySelector = (selector) => selector === ".stage-control.is-selected" ? row.selected : null;
    return row;
  });
  ui.renderProcessLifecycleAction();
  assert.equal(button.disabled, false);
  assert.equal(ui.isDone(job), true);
  assert.equal(ui.currentStage(job).key, "shipping");
  assert.equal(job.stages.welding.status, "not_started");
  form._jobBase = { ...job, polishing: { sentQuantity: 5, returnedQuantity: 4 } };
  ui.renderProcessLifecycleAction();
  assert.equal(button.disabled, true);
  assert.match(note.textContent, /全数戻った後/);
  assert.equal(ui.isDone(form._jobBase), false);
  form._jobBase = job;
  form.rows.at(-1).selected.dataset.status = "working";
  ui.renderProcessLifecycleAction();
  assert.equal(button.disabled, true);
  assert.match(note.textContent, /最終仕上げ/);
  form.rows = [];
  assert.equal(ui.processFormFinishDone(), false);
  assert.equal(ui.progress({ ...job, shippingStatus: "shipped" }), 100);
});

test("local shipment mirrors final-finish validation and preserves unfinished stage records", async () => {
  const { ui } = harness();
  const registered = await ui.api.saveJob({ id: "RETURNED", customer: "QA", product: "ケリソンパンチ", quantity: 5, shippingStatus: "not_ready", stages: stages("working") });
  const data = ui.api.read();
  data.jobs[0].polishing = { sentQuantity: 5, returnedQuantity: 5, history: [] };
  ui.api.write(data);
  const base = { ...registered, shippingStatus: "shipped" };
  await assert.rejects(ui.api.saveJob(base), /最終仕上げを完了/);
  const saved = await ui.api.saveJob({ ...base, stages: stages() });
  assert.equal(saved.shippingStatus, "shipped");
  assert.equal(saved.stages.welding.status, "not_started");
});
