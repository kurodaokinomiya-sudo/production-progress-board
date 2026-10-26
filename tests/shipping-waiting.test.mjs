import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const keys = ["welding", "base", "grinding", "heat", "finish"];
const fixture = (id, finish = "working", overrides = {}) => ({
  id, version: 1, customer: "田中", product: "ケリソンパンチ", category: "ケリソンパンチ", quantity: 5,
  serialNo: id, dueDate: "2099-11-01", archived: false, shippingStatus: "not_ready",
  polishing: { sentQuantity: 5, returnedQuantity: 5, history: [] },
  stages: Object.fromEntries(keys.map((key) => [key, { status: key === "finish" ? finish : "not_started", assignee: "豊" }])),
  ...overrides,
});

function harness(jobs = [], role = "worker", storedSort = {}) {
  const storage = new Map([
    ["production-board-demo-v2", JSON.stringify({ jobs, settings: {}, intake: [], localIntakeParserVersion: 999 })],
    ["production-board-sort-v1", JSON.stringify(storedSort)],
  ]);
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: "", textContent: "", value: "", hidden: false, isConnected: false, open: false, dataset: {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      before(other) { elements.set(`#${other.id}`, other); },
    });
    return elements.get(selector);
  }
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, structuredClone,
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => element(`new-${elements.size}`) },
    window: {}, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, api, filteredJobs, sortedJobs, canWorkOnJob, stageCellButton, shippingCell, orderTableRows, orderTableHeader, ledgerFilterSummary, renderShippingWorkspace, renderCompletedWorkspace, renderFinishedWorkspace, renderMetrics, openProcessDialog, setWorkspaceSort, readStoredJobSort, stageStatusOptions, polishingFinishReady, renderStageEditor, processEditSnapshot };`, context);
  context.delay = async () => {};
  const ui = context.ui;
  ui.state.mode = "demo";
  ui.state.jobs = structuredClone(jobs);
  ui.state.access = { role, canEdit: ["owner", "admin", "editor"].includes(role), canWork: role !== "viewer" };
  return { ui, storage, element };
}

test("final finish partitions active, waiting and shipped jobs without losing legacy ready records", () => {
  const jobs = [fixture("active"), fixture("ready", "done"), fixture("legacy-ready", "done", { shippingStatus: "waiting" }),
    fixture("shipped", "done", { shippingStatus: "shipped" }), fixture("deleted", "done", { archived: true }),
    fixture("polishing", "done", { polishing: { sentQuantity: 5, returnedQuantity: 4 } })];
  const { ui } = harness(jobs);
  assert.deepEqual(Array.from(ui.filteredJobs("orders"), (job) => job.id), ["active", "polishing"]);
  assert.deepEqual(Array.from(ui.filteredJobs("shipping"), (job) => job.id), ["ready", "legacy-ready"]);
  ui.state.filters.completed.period = "all";
  assert.deepEqual(Array.from(ui.filteredJobs("completed"), (job) => job.id), ["shipped"]);
  ui.state.filters.shipping.query = "legacy";
  assert.equal(ui.ledgerFilterSummary("shipping", 1).total, 2);
  assert.equal(ui.ledgerFilterSummary("orders", 2).total, 2);
});

test("worker completion persists into waiting after reload, with further editing and shipping denied", async () => {
  const job = fixture("complete");
  const { ui, storage } = harness([job]);
  const saved = await ui.api.saveJobProcess({ id: job.id, version: 1, stages: { finish: { status: "done", assignee: "豊" } } });
  assert.equal(saved.stages.welding.status, "not_started");
  assert.equal(saved.completedAt, "");
  const reloaded = harness(JSON.parse(storage.get("production-board-demo-v2")).jobs).ui;
  assert.equal(reloaded.filteredJobs("orders").length, 0);
  assert.equal(reloaded.filteredJobs("shipping").length, 1);
  assert.equal(reloaded.canWorkOnJob(saved), false);
  await assert.rejects(reloaded.api.saveJobProcess({ id: saved.id, version: saved.version, stages: job.stages }), /編集権限/);
  await assert.rejects(reloaded.api.saveJobProcess({ id: saved.id, version: saved.version, stages: saved.stages, shippingStatus: "shipped" }), /編集権限/);
});

test("due production summary counts the same scope opened by the production shortcut", () => {
  const { ui, element } = harness([fixture("due-active", "working", { dueDate: "2000-01-01" }), fixture("due-ready", "done", { dueDate: "2000-01-01" })], "editor");
  ui.renderMetrics();
  assert.equal(element("#metric-due").textContent, "1");
  ui.state.filters.orders.attention = "due";
  assert.equal(ui.filteredJobs("orders").length, 1);
  assert.equal(element("#metric-ship").textContent, "1");
});

test("worker cannot combine finishing with shipment or bypass polishing returns", async () => {
  const job = fixture("forged");
  const { ui } = harness([job]);
  const stages = { ...job.stages, finish: { status: "done", assignee: "豊" } };
  await assert.rejects(ui.api.saveJobProcess({ id: job.id, version: 1, stages, shippingStatus: "shipped" }), /編集権限/);
  const polishing = harness([fixture("partial", "working", { polishing: { sentQuantity: 5, returnedQuantity: 4 } })]).ui;
  await assert.rejects(polishing.api.saveJobProcess({ id: "partial", version: 1, stages }), /全数戻るまで/);
});

test("editor shipment moves waiting into completed and reopening restores the waiting queue", async () => {
  const job = fixture("shipment", "done");
  const { ui } = harness([job], "editor");
  const shipped = await ui.api.saveJobProcess({ id: job.id, version: 1, stages: {}, shippingStatus: "shipped" });
  ui.state.jobs = [shipped];
  ui.state.filters.completed.period = "all";
  assert.equal(ui.filteredJobs("shipping").length, 0);
  assert.equal(ui.filteredJobs("completed").length, 1);
  assert.ok(shipped.completedAt);
  const reopened = await ui.api.saveJobProcess({ id: job.id, version: shipped.version, stages: {}, shippingStatus: "waiting" });
  ui.state.jobs = [reopened];
  assert.equal(ui.filteredJobs("orders").length, 0);
  assert.equal(ui.filteredJobs("shipping").length, 1);
  assert.equal(reopened.completedAt, "");
});

test("ready and shipped rows expose only reading for workers and retain editor shipment in every display preset", () => {
  for (const role of ["worker", "viewer", "editor", "admin", "owner"]) {
    const job = fixture("ready", "done");
    const { ui, element } = harness([job], role);
    const editable = ["editor", "admin", "owner"].includes(role);
    for (const display of [{ compact: false, progressOnly: false }, { compact: true, progressOnly: false }, { compact: false, progressOnly: true }]) {
      Object.assign(ui.state.ledgerDisplay, display);
      ui.renderShippingWorkspace();
      const markup = element("#shipping-workspace").innerHTML;
      assert.match(markup, /class="cell-shipping"/);
      assert.match(markup, /表示中の総合計/);
      assert.equal(markup.includes('data-stage-key="shipping"'), editable, `${role} ${JSON.stringify(display)}`);
      if (!editable) assert.doesNotMatch(markup, /data-action="open-process"|data-action="edit-order"/);
    }
    assert.equal(ui.canWorkOnJob({ ...job, shippingStatus: "shipped" }), editable);
    if (!editable) {
      ui.openProcessDialog(job);
      assert.equal(element("#process-dialog").open, false);
    }
  }
});

test("shipping sort preferences persist independently of production and completed lists", () => {
  const { ui, storage } = harness([fixture("B", "done"), fixture("A", "done")], "editor");
  ui.setWorkspaceSort("orders", { sort: "due" });
  ui.setWorkspaceSort("shipping", { sort: "serial", sortDirection: "desc" });
  ui.setWorkspaceSort("completed", { sort: "updated" });
  assert.deepEqual(Array.from(ui.sortedJobs("shipping"), (job) => job.id), ["B", "A"]);
  const reloaded = harness([], "editor", JSON.parse(storage.get("production-board-sort-v1"))).ui;
  assert.equal(reloaded.state.filters.shipping.sort, "serial");
  assert.equal(reloaded.state.filters.shipping.sortDirection, "desc");
  assert.equal(reloaded.state.filters.orders.sort, "due");
  assert.equal(reloaded.state.filters.completed.sort, "updated");
});

test("finished list renders waiting above independently filtered historical shipments for every role", () => {
  for (const role of ["viewer", "worker", "editor", "admin", "owner"]) {
    const jobs = [fixture("ready", "done"), fixture("active"),
      fixture("old-shipment", "done", { shippingStatus: "shipped", completedAt: "2024-05-02T00:00:00Z" }),
      fixture("other-month", "done", { shippingStatus: "shipped", completedAt: "2024-06-02T00:00:00Z" })];
    const { ui, element } = harness(jobs, role);
    ui.state.filters.completed.period = "2024-05";
    ui.renderFinishedWorkspace();
    const waiting = element("#shipping-workspace").innerHTML;
    const shipped = element("#completed-workspace").innerHTML;
    assert.match(waiting, /data-order-id="ready"/);
    assert.doesNotMatch(waiting, /data-order-id="(?:active|old-shipment|other-month)"/);
    assert.match(shipped, /data-order-id="old-shipment"/);
    assert.doesNotMatch(shipped, /data-order-id="(?:active|ready|other-month)"/);
    if (["worker", "viewer"].includes(role)) assert.doesNotMatch(shipped, /data-action="open-process"|data-action="edit-order"/);
    ui.state.filters.completed.query = "no-such-shipment";
    ui.renderFinishedWorkspace();
    assert.equal(element("#shipping-workspace").innerHTML, waiting);
    assert.match(element("#completed-workspace").innerHTML, /条件に合う出荷済み案件がありません/);
  }
});

test("shipment and reopen move the same row between finished sections and survive reload", async () => {
  const job = fixture("finished-movement", "done");
  const { ui, storage, element } = harness([job], "editor");
  ui.state.filters.completed.period = "all";
  ui.renderFinishedWorkspace();
  assert.match(element("#shipping-workspace").innerHTML, /data-order-id="finished-movement"/);
  const shipped = await ui.api.saveJobProcess({ id: job.id, version: 1, stages: {}, shippingStatus: "shipped" });
  ui.state.jobs = [shipped];
  ui.renderFinishedWorkspace();
  assert.doesNotMatch(element("#shipping-workspace").innerHTML, /data-order-id="finished-movement"/);
  assert.match(element("#completed-workspace").innerHTML, /data-order-id="finished-movement"/);
  const reloaded = harness(JSON.parse(storage.get("production-board-demo-v2")).jobs, "editor");
  reloaded.ui.state.filters.completed.period = "all";
  reloaded.ui.renderFinishedWorkspace();
  assert.match(reloaded.element("#completed-workspace").innerHTML, /data-order-id="finished-movement"/);
  const reopened = await reloaded.ui.api.saveJobProcess({ id: job.id, version: shipped.version, stages: {}, shippingStatus: "waiting" });
  reloaded.ui.state.jobs = [reopened];
  reloaded.ui.renderFinishedWorkspace();
  assert.match(reloaded.element("#shipping-workspace").innerHTML, /data-order-id="finished-movement"/);
  assert.doesNotMatch(reloaded.element("#completed-workspace").innerHTML, /data-order-id="finished-movement"/);
});

test("ordinary finish never offers completion; only actual full polishing return enables final completion", () => {
  const { ui, element } = harness();
  for (const polishing of [null, { sentQuantity: 5, returnedQuantity: 0 }, { sentQuantity: 5, returnedQuantity: 4 }, { sentQuantity: 4, returnedQuantity: 4 }, { sentQuantity: 5, returnedQuantity: 6 }]) {
    const job = fixture("ordinary", "working", { polishing });
    assert.equal(ui.polishingFinishReady(job), false);
    assert.equal(ui.stageStatusOptions(job, "finish").some((option) => option.value === "done"), false);
    assert.equal(ui.stageStatusOptions(job, "welding").some((option) => option.value === "done"), true);
    ui.renderStageEditor(job, "finish");
    const finish = element("#process-stage-editor").innerHTML.split('data-stage-key="finish"')[1];
    assert.doesNotMatch(finish, /data-status="done"/);
  }
  const returned = fixture("returned", "working");
  assert.equal(ui.polishingFinishReady(returned), true);
  ui.renderStageEditor(returned, "finish");
  const finish = element("#process-stage-editor").innerHTML.split('data-stage-key="finish"')[1];
  assert.match(finish, /最終仕上げ/);
  assert.match(finish, /data-status="done"/);
});

test("previous ordinary completion recovers into production and worker editing without changing stored rows", async () => {
  const previous = fixture("mistaken", "done", { polishing: null });
  const { ui, storage } = harness([previous]);
  assert.equal(ui.filteredJobs("shipping").length, 0);
  assert.equal(ui.filteredJobs("orders").length, 1);
  assert.equal(ui.canWorkOnJob(previous), true);
  assert.match(ui.stageCellButton(previous, { key: "finish", label: "仕上げ" }), /進行中/);
  assert.equal(JSON.parse(ui.processEditSnapshot(previous)).stages.finish.status, "working");
  assert.equal(JSON.parse(storage.get("production-board-demo-v2")).jobs[0].stages.finish.status, "done", "display recovery never rewrites production records");
  const saved = await ui.api.saveJobProcess({ id: previous.id, version: previous.version, stages: { finish: { status: "working", assignee: "豊" } } });
  assert.equal(saved.stages.finish.status, "working");
});
