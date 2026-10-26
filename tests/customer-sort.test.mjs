import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");

function harness() {
  const storage = new Map();
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { value: "" });
    return elements.get(key);
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document: { querySelector: element }, window: {},
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, compareCustomer, sortedJobs, ledgerJobGroups, distributionJobs, showOrders, showCompleted, renderSortState };`, context);
  context.renderOrdersWorkspace = () => {};
  context.renderCompletedWorkspace = () => {};
  context.switchView = () => {};
  return { ui: context.ui, element };
}

const job = (id, customer, overrides = {}) => ({
  id, customer, product: "鋭匙鉗子", category: "鋭匙鉗子", quantity: 5,
  serialNo: id, dueDate: "2026-10-31", shippingStatus: "not_ready", archived: false,
  completedAt: "2026-10-13T00:00:00.000Z", stages: {}, ...overrides,
});

test("default customer order is Tanaka first, reverse natural order next, and stock last", () => {
  const { ui } = harness();
  const customers = ["在庫用", "得意先2", "松井", "", "田中", "得意先10", "在庫", "粋然"];
  const result = [...customers].sort(ui.compareCustomer);
  assert.equal(result[0], "田中");
  assert.ok(result.indexOf("得意先10") < result.indexOf("得意先2"));
  const expectedMiddle = customers.filter((name) => name && name !== "田中" && !name.startsWith("在庫"))
    .sort((a, b) => new Intl.Collator("ja", { numeric: true, sensitivity: "base" }).compare(b, a));
  assert.deepEqual(result.slice(1, -3), expectedMiddle);
  assert.equal(result.at(-3), "");
  assert.ok(result.slice(-2).every((name) => name.startsWith("在庫")));
  assert.equal(ui.compareCustomer("ﾏｲｽﾃｯｸ", "マイステック"), 0);
  assert.equal(ui.compareCustomer(" 田中 ", "田中"), 0);
});

test("customer remains the default while shortcuts preserve user-selected sort hierarchy", () => {
  const { ui, element } = harness();
  for (const scope of ["dashboard", "orders", "completed"]) assert.equal(ui.state.filters[scope].sort, "customer");
  assert.equal(ui.state.distributionSort, "customer");
  Object.assign(ui.state.filters.orders, { sort: "productCode", sortDirection: "asc", sort2: "due", sort2Direction: "desc", sort3: "quantity", sort3Direction: "asc" });
  ui.showOrders({ attention: "shipping" });
  assert.deepEqual([ui.state.filters.orders.sort, ui.state.filters.orders.sortDirection, ui.state.filters.orders.sort2, ui.state.filters.orders.sort2Direction, ui.state.filters.orders.sort3, ui.state.filters.orders.sort3Direction], ["productCode", "asc", "due", "desc", "quantity", "asc"]);
  assert.equal(element("#orders-sort").value, "productCode");
  assert.equal(ui.state.filters.orders.attention, "shipping");
  Object.assign(ui.state.filters.completed, { sort: "updated", sortDirection: "asc", sort2: "quantity", sort2Direction: "desc", sort3: "due", sort3Direction: "asc" });
  ui.showCompleted("all");
  assert.deepEqual([ui.state.filters.completed.sort, ui.state.filters.completed.sortDirection, ui.state.filters.completed.sort2, ui.state.filters.completed.sort2Direction, ui.state.filters.completed.sort3, ui.state.filters.completed.sort3Direction], ["updated", "asc", "quantity", "desc", "due", "asc"]);
  assert.equal(element("#completed-sort").value, "updated");
  for (const id of ["dashboard", "orders", "completed", "distribution"]) {
    const select = html.match(new RegExp(`<select id="${id}-sort">([\\s\\S]*?)</select>`))[1];
    assert.match(select, /^\s*<option value="customer" selected>/);
  }
});

test("category tables retain Tanaka first and stock last without changing jobs or their serial order", () => {
  const { ui } = harness();
  const original = [job("stock", "在庫用"), job("tanaka10", "田中", { serialNo: "10" }), job("tanaka2", "田中", { serialNo: "2" }), job("other", "松井"), job("k-stock", "在庫", { category: "ケリソンパンチ" }), job("k-tanaka", "田中", { category: "ケリソンパンチ" })];
  ui.state.jobs = original;
  const sorted = ui.sortedJobs("orders");
  for (const [, jobs] of ui.ledgerJobGroups(sorted)) {
    assert.equal(jobs[0].customer, "田中");
    assert.ok(jobs.at(-1).customer.startsWith("在庫"));
  }
  assert.ok(sorted.findIndex((entry) => entry.id === "tanaka2") < sorted.findIndex((entry) => entry.id === "tanaka10"));
  assert.deepEqual(original.map((entry) => entry.id), ["stock", "tanaka10", "tanaka2", "other", "k-stock", "k-tanaka"]);
  assert.ok(sorted.every((entry) => entry.quantity === 5));
  ui.state.jobs = original.map((entry) => ({ ...entry, shippingStatus: "shipped" }));
  ui.state.filters.completed.period = "all";
  assert.equal(ui.sortedJobs("completed")[0].customer, "田中");
});

test("distribution follows the same customer order while keeping each customer's due dates ascending", () => {
  const { ui } = harness();
  ui.state.distributionMonth = "2026-10";
  ui.state.jobs = [job("stock", "在庫用", { dueDate: "2026-10-01" }), job("tanaka-late", "田中"), job("tanaka-early", "田中", { dueDate: "2026-10-02" }), job("other", "松井")];
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), ["tanaka-early", "tanaka-late", "other", "stock"]);
  assert.equal(ui.distributionJobs({ sort: "due" })[0].id, "stock");
});

test("customer table headers announce descending sort", () => {
  const { ui } = harness();
  const header = { dataset: { sortKey: "customer" }, removeAttribute() {}, setAttribute(name, value) { this[name] = value; } };
  ui.renderSortState({ querySelectorAll: () => [header] }, "orders");
  assert.equal(header["aria-sort"], "descending");
});
