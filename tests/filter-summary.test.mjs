import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));

function harness() {
  const storage = new Map();
  const elements = new Map();
  const frames = new Map();
  let frameId = 0;
  function element(id) {
    let markup = "", surface = null;
    return {
      id, hidden: false, value: "", textContent: "", isConnected: false, writes: 0,
      get innerHTML() { return markup; },
      set innerHTML(value) {
        markup = value;
        this.writes += 1;
        surface = value.includes('class="ledger-viewport"') ? { scrollTop: 0, scrollLeft: 0 } : null;
      },
      querySelector(selector) { return selector === ".ledger-viewport" ? surface : null; },
      querySelectorAll() { return []; },
      before(sibling) {
        sibling.beforeWorkspace = id;
        elements.set(`#${sibling.id}`, sibling);
      },
    };
  }
  ["orders-workspace", "completed-workspace", "orders-result-count", "completed-result-summary", "orders-search", "orders-stage-filter", "orders-attention-filter", "orders-sort", "completed-search", "completed-year", "completed-month", "completed-sort", "live-region"].forEach((id) => elements.set(`#${id}`, element(id)));
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll() { return []; },
    createElement() { return element(""); },
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document, window: {},
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, todayIso, filteredJobs, ledgerFilterSummary, renderOrdersWorkspace, renderCompletedWorkspace, clearWorkspaceFilters };`, context);
  context.ui.state.mode = "demo";
  context.ui.state.access = { role: "owner", canEdit: true, canWork: true };
  return { ui: context.ui, elements, storage, frames };
}

function job(id, overrides = {}) {
  return {
    id, customer: "検証商事", product: "ケリソンパンチ 18cm", quantity: 2,
    serialNo: id, dueDate: "2099-11-10", archived: false, shippingStatus: "not_ready",
    stages: Object.fromEntries(["welding", "base", "grinding", "heat", "finish"].map((key) => [key, { status: "todo", assignee: "" }])),
    ...overrides,
  };
}

test("sorting alone does not show a filter notice in either ledger preset", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [job("A-1")];
  ui.state.filters.orders.sort = "customer";
  for (const compact of [false, true]) {
    ui.state.ledgerDisplay.compact = compact;
    ui.renderOrdersWorkspace();
    assert.equal(elements.has("#orders-filter-summary"), false);
    assert.equal(elements.get("#orders-result-count").textContent, "1件・2丁");
  }
});

test("active order filters remain outside the collapsed filter panel with a scoped denominator", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [job("QA-1"), job("B-1"), job("C-1"), job("QA-shipped", { shippingStatus: "shipped" }), job("QA-deleted", { archived: true })];
  ui.state.filters.orders.query = "QA-1";
  for (const compact of [false, true]) {
    ui.state.ledgerDisplay.compact = compact;
    ui.renderOrdersWorkspace();
    const notice = elements.get("#orders-filter-summary");
    assert.equal(notice.hidden, false);
    assert.equal(notice.beforeWorkspace, "orders-workspace");
    assert.equal(notice.className, "ledger-filter-summary");
    assert.match(notice.innerHTML, /絞り込み中 1\/3件/);
    assert.match(notice.innerHTML, /検索「QA-1」/);
    assert.match(notice.innerHTML, /data-action="clear-orders-filter"/);
  }
});

test("stage and attention filters state their current meanings without requiring a search", () => {
  const { ui, elements } = harness();
  const stages = Object.fromEntries(["welding", "base", "grinding", "heat", "finish"].map((key) => [key, { status: ["welding", "base", "grinding"].includes(key) ? "done" : "todo", assignee: "" }]));
  ui.state.jobs = [job("heat-1", { stages }), job("weld-1")];
  ui.state.filters.orders.stage = "heat";
  ui.state.filters.orders.attention = "production";
  ui.renderOrdersWorkspace();
  const notice = elements.get("#orders-filter-summary");
  assert.match(notice.innerHTML, /絞り込み中 1\/2件/);
  assert.match(notice.innerHTML, /工程：頭付け・幅取り／厚みとり/);
  assert.match(notice.innerHTML, /状況：製作中/);
});

test("clearing orders removes only its filters and preserves sort, zoom, and other views", () => {
  const { ui, elements, storage } = harness();
  ui.state.jobs = [job("A-1"), job("B-1")];
  Object.assign(ui.state.filters.orders, { query: "missing", stage: "welding", attention: "production", sort: "serial", sortDirection: "desc", sort2: "due", sort2Direction: "asc", sort3: "quantity", sort3Direction: "desc" });
  ui.state.filters.completed.query = "retain-completed";
  ui.state.filters.dashboard.query = "retain-dashboard";
  ui.state.ledgerDisplay = { mode: "manual", scale: 73, rows: 23, compact: true };
  const display = copy(ui.state.ledgerDisplay), beforeStorage = copy([...storage]);
  ui.renderOrdersWorkspace();
  assert.match(elements.get("#orders-workspace").innerHTML, /data-action="clear-orders-filter"/);
  assert.match(elements.get("#orders-filter-summary").innerHTML, /絞り込み中 0\/2件/);
  ui.clearWorkspaceFilters("orders");
  assert.deepEqual(copy(ui.state.filters.orders), { query: "", stage: "all", attention: "all", sort: "serial", sortDirection: "desc", sort2: "due", sort2Direction: "asc", sort3: "quantity", sort3Direction: "desc" });
  assert.equal(ui.state.filters.completed.query, "retain-completed");
  assert.equal(ui.state.filters.dashboard.query, "retain-dashboard");
  assert.deepEqual(copy(ui.state.ledgerDisplay), display);
  assert.deepEqual(copy([...storage]), beforeStorage);
  assert.equal(elements.get("#orders-filter-summary").hidden, true);
  assert.equal(elements.get("#orders-result-count").textContent, "2件・4丁");
  assert.equal(elements.get("#orders-search").value, "");
  assert.equal(elements.get("#orders-stage-filter").value, "all");
  assert.equal(elements.get("#orders-attention-filter").value, "all");
});

test("completed filters count all nondeleted shipped jobs and clear the period without resetting sort or zoom", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [job("QA-now", { shippingStatus: "shipped", completedAt: `${ui.todayIso()}T09:00:00+09:00` }), job("old", { shippingStatus: "shipped", completedAt: "2000-01-01T00:00:00Z" }), job("pending"), job("deleted", { archived: true, shippingStatus: "shipped" })];
  Object.assign(ui.state.filters.completed, { query: "QA", period: "current", sort: "serial", sortDirection: "asc", sort2: "quantity", sort2Direction: "desc", sort3: "due", sort3Direction: "asc" });
  ui.state.ledgerDisplay = { mode: "manual", scale: 91, rows: 33, compact: false };
  const display = copy(ui.state.ledgerDisplay);
  ui.renderCompletedWorkspace();
  const notice = elements.get("#completed-filter-summary");
  assert.match(notice.innerHTML, /絞り込み中 1\/2件/);
  assert.match(notice.innerHTML, /検索「QA」・完了期間：今月/);
  assert.match(notice.innerHTML, /data-action="clear-completed-filter"/);
  ui.clearWorkspaceFilters("completed");
  assert.deepEqual(copy(ui.state.filters.completed), { query: "", stage: "all", period: "all", sort: "serial", sortDirection: "asc", sort2: "quantity", sort2Direction: "desc", sort3: "due", sort3Direction: "asc" });
  assert.deepEqual(copy(ui.state.ledgerDisplay), display);
  assert.equal(elements.get("#completed-year").value, "all");
  assert.equal(elements.get("#completed-month").value, "all");
  assert.equal(elements.get("#completed-month").disabled, true);
  assert.equal(elements.get("#completed-result-summary").textContent, "全期間 2件・4丁");
  assert.equal(notice.hidden, true);
});

test("sync can update the filter denominator without redrawing unchanged rows or losing scroll", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [job("QA-1"), job("B-1")];
  ui.state.filters.orders.query = "QA";
  ui.renderOrdersWorkspace();
  const workspace = elements.get("#orders-workspace"), notice = elements.get("#orders-filter-summary");
  const original = workspace.querySelector(".ledger-viewport");
  original.scrollTop = 190;
  original.scrollLeft = 35;
  const writes = workspace.writes, noticeWrites = notice.writes;
  ui.state.jobs = copy(ui.state.jobs);
  ui.renderOrdersWorkspace();
  assert.equal(workspace.writes, writes);
  assert.equal(notice.writes, noticeWrites);
  ui.state.jobs.push(job("C-1"));
  ui.renderOrdersWorkspace();
  assert.match(notice.innerHTML, /絞り込み中 1\/3件/);
  assert.equal(workspace.writes, writes);
  assert.equal(workspace.querySelector(".ledger-viewport"), original);
  assert.equal(original.scrollTop, 190);
  assert.equal(original.scrollLeft, 35);
});

test("search text is escaped when the persistent filter summary is rendered", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [job("A-1")];
  ui.state.filters.orders.query = '<img src=x onerror="alert(1)">';
  ui.renderOrdersWorkspace();
  const markup = elements.get("#orders-filter-summary").innerHTML;
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(markup, /<img/);
});
