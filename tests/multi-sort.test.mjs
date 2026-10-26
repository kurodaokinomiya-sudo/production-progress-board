import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const sortStorageKey = "production-board-sort-v1";
const sortEventsStart = source.indexOf('  ["orders", "shipping", "completed"].forEach((scope) => {', source.indexOf("function bindEvents()"));
const sortEventsEnd = source.indexOf('  [qs("#order-form")', sortEventsStart);
assert.ok(sortEventsStart > 0 && sortEventsEnd > sortEventsStart, "workspace sort event handlers are available");

function harness({ stored = null, storageMode = "normal" } = {}) {
  const storage = new Map(stored == null ? [] : [[sortStorageKey, stored]]);
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, {
      value: "", textContent: "",
      innerHTML: html.match(new RegExp(`<select id="${key.slice(1)}"[^>]*>([\\s\\S]*?)</select>`))?.[1] || "",
      listeners: new Map(),
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      dispatch(type) { this.listeners.get(type)?.({ target: this }); },
    });
    return elements.get(key);
  };
  const localStorage = {
    getItem(key) {
      if (storageMode === "unavailable" && key === sortStorageKey) throw new Error("storage unavailable");
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageMode === "unavailable" && key === sortStorageKey) throw new Error("storage unavailable");
      storage.set(key, String(value));
    },
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document: { querySelector: element }, window: {}, localStorage,
    requestAnimationFrame: (callback) => callback(),
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, sortedJobs, readStoredJobSort, setWorkspaceSort, renderWorkspaceSortControls, showOrders, showCompleted };`, context);
  context.renderOrdersWorkspace = () => context.ui.renderWorkspaceSortControls("orders");
  context.renderCompletedWorkspace = () => context.ui.renderWorkspaceSortControls("completed");
  context.switchView = () => {};
  vm.runInContext(source.slice(sortEventsStart, sortEventsEnd), context);
  return { ui: context.ui, storage, element };
}

const job = (id, overrides = {}) => ({
  id, customer: "得意先", product: "鉗子", productCode: "P1", category: "鋭匙鉗子",
  quantity: 4, serialNo: id, dueDate: "2026-10-31", updatedAt: "2026-10-12T00:00:00Z",
  completedAt: "2026-10-13T00:00:00Z", shippingStatus: "not_ready", archived: false,
  stages: {}, ...overrides,
});
const ids = (ui, scope = "orders") => Array.from(ui.sortedJobs(scope), ({ id }) => id);

test("workspace sort defaults and shortcuts retain the user's selected hierarchy", () => {
  const { ui, element } = harness();
  for (const scope of ["orders", "completed"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(ui.state.filters[scope])), {
      query: "", stage: "all", ...(scope === "orders" ? { attention: "all" } : { period: "current" }),
      sort: "customer", sortDirection: "desc", sort2: "serial", sort2Direction: "asc", sort3: "none", sort3Direction: "asc",
    });
  }
  ui.setWorkspaceSort("orders", { sort: "productCode", sortDirection: "asc", sort2: "due", sort2Direction: "desc", sort3: "quantity", sort3Direction: "asc" });
  ui.setWorkspaceSort("completed", { sort: "updated", sortDirection: "asc" });
  const before = [ui.state.filters.orders.sort, ui.state.filters.orders.sort2, ui.state.filters.orders.sort3,
    ui.state.filters.completed.sort, ui.state.filters.completed.sort2, ui.state.filters.completed.sort3];
  ui.showOrders({ attention: "shipping" });
  ui.showCompleted("all");
  assert.deepEqual([ui.state.filters.orders.sort, ui.state.filters.orders.sort2, ui.state.filters.orders.sort3,
    ui.state.filters.completed.sort, ui.state.filters.completed.sort2, ui.state.filters.completed.sort3], before);
  assert.equal(element("#orders-sort").value, "productCode");
  assert.equal(element("#completed-sort").value, "updated");
});

test("primary, secondary and tertiary criteria sort naturally, preserve blank-last, and use serial/id tie-breaks", () => {
  const { ui } = harness();
  ui.state.jobs = [
    job("10", { product: "鉗子10", productCode: "P10", serialNo: "10", dueDate: "2026-11-01" }),
    job("2", { product: "鉗子2", productCode: "P2", serialNo: "2", dueDate: "2026-10-01" }),
    job("5", { product: "鉗子5", productCode: "P5", serialNo: "5", dueDate: "2026-10-05" }),
  ];
  ui.setWorkspaceSort("orders", { sort: "product", sortDirection: "asc", sort2: "none", sort3: "none" });
  assert.deepEqual(ids(ui), ["2", "5", "10"]);
  const missing = ui.state.jobs.find((entry) => entry.id === "5");
  missing.product = "";
  missing.productCode = "";
  missing.serialNo = "";
  missing.dueDate = "";
  ui.setWorkspaceSort("orders", { sort: "productCode", sortDirection: "asc" });
  assert.deepEqual(ids(ui), ["2", "10", "5"]);
  ui.setWorkspaceSort("orders", { sort: "serial", sortDirection: "desc" });
  assert.deepEqual(ids(ui), ["10", "2", "5"]);
  ui.state.jobs = [job("z", { serialNo: "2" }), job("b", { serialNo: "2" }), job("a", { serialNo: "2" })];
  ui.setWorkspaceSort("orders", { sort: "quantity", sortDirection: "asc", sort2: "none", sort3: "none" });
  assert.deepEqual(ids(ui), ["a", "b", "z"]);
});

test("missing product names remain blank-last in either sort direction", () => {
  const { ui } = harness();
  ui.state.jobs = [job("blank", { product: "" }), job("2", { product: "鉗子2" }), job("10", { product: "鉗子10" })];
  for (const direction of ["asc", "desc"]) {
    ui.setWorkspaceSort("orders", { sort: "product", sortDirection: direction, sort2: "none", sort3: "none" });
    assert.equal(ids(ui).at(-1), "blank", direction);
  }
});

test("blank values stay last in either direction and customer anchors do not reverse", () => {
  const { ui } = harness();
  ui.state.jobs = [
    job("blank", { productCode: "", dueDate: "", quantity: "", updatedAt: "" }),
    job("2", { productCode: "P2", dueDate: "2026-10-02", quantity: 2, updatedAt: "2026-10-02" }),
    job("10", { productCode: "P10", dueDate: "2026-10-10", quantity: 10, updatedAt: "2026-10-10" }),
  ];
  for (const criterion of ["productCode", "due", "quantity", "updated"]) {
    for (const direction of ["asc", "desc"]) {
      ui.setWorkspaceSort("orders", { sort: criterion, sortDirection: direction, sort2: "none", sort3: "none" });
      assert.equal(ids(ui).at(-1), "blank", `${criterion} ${direction}`);
    }
  }
  ui.state.jobs = [job("stock", { customer: "在庫用" }), job("other", { customer: "松井" }), job("tanaka", { customer: "田中" })];
  for (const direction of ["asc", "desc"]) {
    ui.setWorkspaceSort("orders", { sort: "customer", sortDirection: direction, sort2: "none", sort3: "none" });
    assert.deepEqual(ids(ui), ["tanaka", "other", "stock"]);
  }
});

test("each criterion is applied once and secondary/tertiary keys resolve in order", () => {
  const { ui } = harness();
  ui.state.jobs = [
    job("b", { product: "同じ", productCode: "B", serialNo: "2" }),
    job("a", { product: "同じ", productCode: "A", serialNo: "9" }),
    job("c", { product: "同じ", productCode: "B", serialNo: "1" }),
  ];
  ui.setWorkspaceSort("orders", { sort: "product", sortDirection: "asc", sort2: "product", sort2Direction: "desc", sort3: "productCode", sort3Direction: "asc" });
  assert.equal(ui.state.filters.orders.sort2, "none", "duplicate key is clamped rather than applied twice");
  assert.deepEqual(ids(ui), ["a", "c", "b"]);
});

test("sort preferences persist independently per workspace and invalid storage safely falls back", () => {
  const first = harness();
  first.ui.setWorkspaceSort("orders", { sort: "productCode", sortDirection: "asc", sort2: "due", sort2Direction: "desc" });
  first.ui.setWorkspaceSort("completed", { sort: "updated", sortDirection: "asc", sort2: "quantity", sort2Direction: "desc" });
  const saved = JSON.parse(first.storage.get(sortStorageKey));
  assert.equal(saved.orders.sort, "productCode");
  assert.equal(saved.completed.sort, "updated");
  assert.equal(saved.completed.sort2, "quantity");
  const restored = harness({ stored: JSON.stringify(saved) }).ui;
  assert.equal(restored.state.filters.orders.sort2, "due");
  assert.equal(restored.state.filters.completed.sortDirection, "asc");

  const corrupt = harness({ stored: "{broken" }).ui;
  assert.equal(corrupt.readStoredJobSort("orders").sort, "customer");
  assert.equal(corrupt.readStoredJobSort("completed").sort2, "serial");
  const malformed = harness({ stored: JSON.stringify({ orders: { sort: "unknown", sort2: "customer", sort3: "category", sortDirection: "sideways" }, completed: { sort: "priority", sort2: "updated", sort3: "updated" } }) }).ui;
  assert.deepEqual(JSON.parse(JSON.stringify(malformed.readStoredJobSort("orders"))), {
    sort: "customer", sortDirection: "desc", sort2: "none", sort2Direction: "desc", sort3: "category", sort3Direction: "asc",
  });
  assert.equal(malformed.readStoredJobSort("completed").sort, "customer", "priority is unavailable in completed lists");
  const unavailable = harness({ storageMode: "unavailable" });
  assert.doesNotThrow(() => unavailable.ui.setWorkspaceSort("orders", { sort: "due" }));
  assert.equal(unavailable.ui.state.filters.orders.sort, "due");
});

test("orders and completed sort separately without mutating the underlying job data", () => {
  const { ui } = harness();
  const sourceJobs = [job("b", { serialNo: "2" }), job("a", { serialNo: "1", shippingStatus: "shipped" }), job("c", { serialNo: "3", shippingStatus: "shipped" })];
  const original = JSON.stringify(sourceJobs);
  ui.state.jobs = sourceJobs;
  ui.state.filters.completed.period = "all";
  ui.setWorkspaceSort("orders", { sort: "serial", sortDirection: "desc", sort2: "none", sort3: "none" });
  ui.setWorkspaceSort("completed", { sort: "serial", sortDirection: "asc", sort2: "none", sort3: "none" });
  assert.deepEqual(ids(ui, "orders"), ["b"]);
  assert.deepEqual(ids(ui, "completed"), ["a", "c"]);
  assert.equal(JSON.stringify(sourceJobs), original);
});

test("all three sort levels announce the displayed date label in both directions", () => {
  const fields = ["sort", "sort2", "sort3"];
  for (const scope of ["orders", "completed"]) {
    const dateLabel = scope === "completed" ? "出荷完了日" : "更新日";
    for (const [level, field] of fields.entries()) {
      const { ui, element } = harness();
      ui.state.jobs = [job("one", { shippingStatus: scope === "completed" ? "shipped" : "not_ready" })];
      ui.state.filters.completed.period = "all";
      ui.setWorkspaceSort(scope, { sort: "product", sort2: "quantity", sort3: "serial" });
      ui.renderWorkspaceSortControls(scope);
      const select = element(`#${scope}-${field}`);
      assert.equal(select.innerHTML.match(/<option value="updated"[^>]*>([^<]+)<\/option>/)?.[1], dateLabel, `${scope} ${field} option`);
      select.value = "updated";
      select.dispatch("change");
      assert.match(element("#live-region").textContent, new RegExp(`${dateLabel}降順`), `${scope} ${field} selection change`);
      for (const direction of ["asc", "desc"]) {
        const control = element(`#${scope}-${field}-direction`);
        control.value = direction;
        control.dispatch("change");
        const labels = ["品名昇順", "数量昇順", "連番昇順"];
        labels[level] = `${dateLabel}${direction === "desc" ? "降順" : "昇順"}`;
        assert.equal(element("#live-region").textContent, `1件を${labels.join("、次に")}に並べ替えました`, `${scope} ${field} ${direction}`);
      }
    }
  }
});

test("date sorting keeps shipment dates for completed lists and update dates for orders", () => {
  const { ui } = harness();
  ui.state.filters.completed.period = "all";
  for (const scope of ["orders", "completed"]) {
    ui.state.jobs = [
      job("a", { shippingStatus: scope === "completed" ? "shipped" : "not_ready", updatedAt: "2026-10-12T00:00:00Z", completedAt: "2026-10-13T00:00:00Z" }),
      job("b", { shippingStatus: scope === "completed" ? "shipped" : "not_ready", updatedAt: "2026-10-13T00:00:00Z", completedAt: "2026-10-12T00:00:00Z" }),
    ];
    for (const [level, field] of ["sort", "sort2", "sort3"].entries()) {
      ui.setWorkspaceSort(scope, {
        sort: "product", sortDirection: "asc", sort2: level === 2 ? "quantity" : "none", sort2Direction: "asc", sort3: "none",
        [field]: "updated", [`${field}Direction`]: "asc",
      });
      assert.deepEqual(ids(ui, scope), scope === "completed" ? ["b", "a"] : ["a", "b"], `${scope} ${field} asc`);
      ui.setWorkspaceSort(scope, { [`${field}Direction`]: "desc" });
      assert.deepEqual(ids(ui, scope), scope === "completed" ? ["a", "b"] : ["b", "a"], `${scope} ${field} desc`);
    }
  }
});
